import {
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  defineChain,
  type Hash,
  type HttpTransport,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { Agent, createAgentConfig } from "./agent.js";
import {
  accountIdFromInt,
  accountIdToAddress,
  addressToAccountId,
  buildTransferData,
  getAgentPrivateKeys,
} from "./evolve-utils.js";
import { MetricsCollector } from "./metrics.js";
import type { PoolConfig, PoolMetrics, RequestResult } from "./types.js";

// Genesis token account ID (last 2 bytes = 0xffff = 65535)
const TOKEN_ACCOUNT_ID = accountIdFromInt(65535n);

export class AgentPool {
  private config: PoolConfig;
  private agents: Agent[] = [];
  private metrics: MetricsCollector;
  private running: boolean = false;
  private metricsInterval: ReturnType<typeof setInterval> | null = null;
  private topUpInterval: ReturnType<typeof setInterval> | null = null;
  private onMetricsUpdate: ((metrics: PoolMetrics) => void) | null = null;

  // Stored after initialize() for top-ups
  private faucetWallet: WalletClient<HttpTransport, Chain, PrivateKeyAccount> | null = null;
  private chainPublicClient: PublicClient<HttpTransport, Chain> | null = null;
  private tokenAddress: Address | null = null;

  constructor(config: PoolConfig) {
    this.config = config;
    this.metrics = new MetricsCollector();
  }

  setMetricsHandler(handler: (metrics: PoolMetrics) => void): void {
    this.onMetricsUpdate = handler;
  }

  async initialize(): Promise<void> {
    const agentKeys = getAgentPrivateKeys(this.config.agentCount);
    const agentCount = agentKeys.length;
    console.log(`Initializing pool with ${agentCount} agents...`);

    const publicClient = createPublicClient({
      transport: http(this.config.evolveRpcUrl),
    });

    // Get chain ID dynamically
    const chainId = await publicClient.getChainId();
    console.log(`Chain ID: ${chainId}`);

    const evolveChain = defineChain({
      id: chainId,
      name: "Evolve Testnet",
      nativeCurrency: { decimals: 18, name: "Evolve", symbol: "EVO" },
      rpcUrls: { default: { http: [this.config.evolveRpcUrl] } },
    });

    // Set up faucet wallet
    const faucetAccount = privateKeyToAccount(this.config.faucetPrivateKey);
    const faucetWallet = createWalletClient({
      account: faucetAccount,
      chain: evolveChain,
      transport: http(this.config.evolveRpcUrl),
    });

    const chainPublicClient = createPublicClient({
      chain: evolveChain,
      transport: http(this.config.evolveRpcUrl),
    });

    console.log(`Faucet address: ${faucetAccount.address}`);

    // Derive token contract Ethereum address from genesis AccountId
    const tokenAddress = accountIdToAddress(TOKEN_ACCOUNT_ID);
    console.log(`Token contract address: ${tokenAddress}`);

    // Calculate RPS per agent
    const rpsPerAgent = this.config.requestsPerSecond / agentCount;

    // Fund first agent to verify token contract works
    const firstKey = agentKeys[0];
    const firstAgentConfig = createAgentConfig(
      `agent-000`,
      firstKey,
      rpsPerAgent,
      this.config.endpoints,
      TOKEN_ACCOUNT_ID,
      chainId,
    );
    const firstAgentAccountId = addressToAccountId(firstAgentConfig.address);
    const firstFundData = buildTransferData(firstAgentAccountId, this.config.fundingAmount);

    console.log(
      `Funding agent ${firstAgentConfig.id} (${firstAgentConfig.address.slice(0, 10)}...)...`,
    );
    const firstTxHash = await faucetWallet.sendTransaction({
      to: tokenAddress,
      data: firstFundData,
      value: 0n,
      gas: 100_000n,
    });
    const firstReceipt = await chainPublicClient.waitForTransactionReceipt({ hash: firstTxHash });
    if (firstReceipt.status !== "success") {
      throw new Error(`Token transfer to first agent reverted (tx: ${firstTxHash})`);
    }
    console.log(`Funded agent ${firstAgentConfig.id} with ${this.config.fundingAmount} tokens`);

    const firstAgent = new Agent(firstAgentConfig, this.config.serverUrl, this.config.evolveRpcUrl);
    firstAgent.setResultHandler((result) => this.handleAgentResult(result));
    this.agents.push(firstAgent);
    this.metrics.registerAgent(firstAgentConfig.id, firstAgentConfig.address);

    // Fund remaining agents with explicit nonce management.
    // Evolve's pending nonce may not reflect unconfirmed txs, so we track it locally.
    let faucetNonce = await chainPublicClient.getTransactionCount({
      address: faucetAccount.address,
      blockTag: "pending",
    });

    const fundingTxHashes: Hash[] = [];
    const pendingAgents: { config: ReturnType<typeof createAgentConfig> }[] = [];

    for (let i = 1; i < agentCount; i++) {
      const privateKey = agentKeys[i];
      const agentConfig = createAgentConfig(
        `agent-${i.toString().padStart(3, "0")}`,
        privateKey,
        rpsPerAgent,
        this.config.endpoints,
        TOKEN_ACCOUNT_ID,
        chainId,
      );

      const agentAccountId = addressToAccountId(agentConfig.address);
      const data = buildTransferData(agentAccountId, this.config.fundingAmount);

      console.log(
        `Funding agent ${agentConfig.id} (${agentConfig.address.slice(0, 10)}...) with ${this.config.fundingAmount} tokens`,
      );

      const txHash = await faucetWallet.sendTransaction({
        nonce: faucetNonce,
        to: tokenAddress,
        data,
        value: 0n,
        gas: 100_000n,
      });
      faucetNonce++;

      fundingTxHashes.push(txHash);
      pendingAgents.push({ config: agentConfig });
    }

    // Wait only for the last receipt - all prior ones are confirmed by then
    if (fundingTxHashes.length > 0) {
      const lastTxHash = fundingTxHashes[fundingTxHashes.length - 1];
      await chainPublicClient.waitForTransactionReceipt({ hash: lastTxHash });
    }

    // Create all agents after funding is confirmed
    for (const { config: agentConfig } of pendingAgents) {
      const agent = new Agent(agentConfig, this.config.serverUrl, this.config.evolveRpcUrl);

      agent.setResultHandler((result) => this.handleAgentResult(result));

      this.agents.push(agent);
      this.metrics.registerAgent(agentConfig.id, agentConfig.address);
    }

    // Store for top-ups
    this.faucetWallet = faucetWallet;
    this.chainPublicClient = chainPublicClient;
    this.tokenAddress = tokenAddress;

    console.log(`Pool initialized with ${this.agents.length} agents`);
  }

  private handleAgentResult(result: RequestResult): void {
    this.metrics.recordRequest(result);

    const status = result.success ? "OK" : "FAIL";
    const latency = `${result.latencyMs}ms`;
    const payment = result.paymentLatencyMs ? ` (payment: ${result.paymentLatencyMs}ms)` : "";
    const error = result.error ? ` - ${result.error}` : "";

    console.log(`[${result.agentId}] ${status} ${result.endpoint} ${latency}${payment}${error}`);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    console.log("\nStarting agents...");
    this.metrics.start();

    // Stagger agent starts to spread load evenly
    const staggerWindowMs = 1000 / this.config.requestsPerSecond;
    await Promise.all(
      this.agents.map((agent) => {
        const delay = Math.random() * staggerWindowMs;
        return new Promise<void>((resolve) =>
          setTimeout(async () => {
            await agent.start();
            resolve();
          }, delay),
        );
      }),
    );

    this.metricsInterval = setInterval(() => {
      const poolMetrics = this.metrics.getPoolMetrics();
      this.onMetricsUpdate?.(poolMetrics);
      console.log(this.metrics.formatSummary());
    }, 5000);

    // Start auto top-up loop if configured
    if (this.config.topUpInterval > 0) {
      const intervalMs = this.config.topUpInterval * 1000;
      console.log(`Auto top-up enabled: every ${this.config.topUpInterval}s`);
      this.topUpInterval = setInterval(() => {
        this.fundAgents().catch((err) => {
          console.error("Top-up cycle failed:", err);
        });
      }, intervalMs);
    }

    console.log(`All ${this.agents.length} agents started`);
    console.log(`Target TPS: ${this.config.requestsPerSecond}`);
    console.log(`Server: ${this.config.serverUrl}`);
    console.log("");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    console.log("\nStopping agents...");

    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
    if (this.topUpInterval) {
      clearInterval(this.topUpInterval);
      this.topUpInterval = null;
    }

    await Promise.all(this.agents.map((agent) => agent.stop()));

    console.log("All agents stopped");
    console.log(this.metrics.formatSummary());
  }

  /**
   * Fund all agents with fundingAmount tokens from the faucet.
   * Sends transfers in sequence (faucet nonce management) and waits for the
   * last receipt to confirm the batch. Skips agents whose tx fails and aborts
   * the batch on the first send error to avoid nonce desync.
   */
  private async fundAgents(): Promise<void> {
    if (!this.faucetWallet || !this.chainPublicClient || !this.tokenAddress) return;
    if (this.agents.length === 0) return;

    const start = Date.now();
    console.log(`[top-up] Funding ${this.agents.length} agents...`);

    // Fetch current nonce once — Evolve's pending count doesn't reflect
    // unconfirmed txs, so we must track it locally within the batch.
    let nonce = await this.chainPublicClient.getTransactionCount({
      address: this.faucetWallet.account.address,
      blockTag: "pending",
    });

    const txHashes: Hash[] = [];
    let failed = 0;
    for (const agent of this.agents) {
      try {
        const agentAccountId = addressToAccountId(agent.address);
        const data = buildTransferData(agentAccountId, this.config.fundingAmount);
        const txHash = await this.faucetWallet.sendTransaction({
          nonce,
          to: this.tokenAddress,
          data,
          value: 0n,
          gas: 100_000n,
        });
        nonce++;
        txHashes.push(txHash);
      } catch (err) {
        failed++;
        console.error(`[top-up] Failed to send tx for ${agent.id}:`, err);
        // A send error likely means a nonce desync; stop the batch so the
        // next cycle starts with a fresh nonce from the wallet client.
        break;
      }
    }

    // Wait for the last tx to confirm (all prior ones are confirmed by then)
    if (txHashes.length > 0) {
      const lastTxHash = txHashes[txHashes.length - 1];
      await this.chainPublicClient.waitForTransactionReceipt({ hash: lastTxHash });
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const status = failed > 0 ? ` (aborted after ${failed} failure)` : "";
    console.log(
      `[top-up] Funded ${txHashes.length}/${this.agents.length} agents with ${this.config.fundingAmount} tokens each (${elapsed}s)${status}`,
    );
  }

  getMetrics(): PoolMetrics {
    return this.metrics.getPoolMetrics();
  }

  async getAgentBalances(): Promise<Map<string, bigint>> {
    const balances = new Map<string, bigint>();
    await Promise.all(
      this.agents.map(async (agent) => {
        const balance = await agent.getBalance();
        balances.set(agent.id, balance);
        this.metrics.updateAgentBalance(agent.id, balance);
      }),
    );
    return balances;
  }
}
