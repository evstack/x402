import type { FacilitatorClient } from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { Address } from "viem";
import { type EvolveClient, getTransaction, getTransactionReceipt } from "../evolve.js";

const TX_HASH_TTL_MS = 3_600_000; // 1 hour

export class EvolveFacilitatorClient implements FacilitatorClient {
  private usedTxHashes = new Map<string, number>();
  private network: Network;
  private client: EvolveClient;

  constructor(client: EvolveClient, network: Network) {
    this.client = client;
    this.network = network;
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [hash, ts] of this.usedTxHashes) {
      if (now - ts > TX_HASH_TTL_MS) this.usedTxHashes.delete(hash);
    }
  }

  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    this.evictStale();

    const txHash = paymentPayload.payload.txHash as string;

    if (!txHash) {
      return { isValid: false, invalidReason: "Missing transaction hash" };
    }

    if (this.usedTxHashes.has(txHash)) {
      return { isValid: false, invalidReason: "Transaction already used" };
    }

    try {
      const receipt = await getTransactionReceipt(this.client, txHash as `0x${string}`);

      if (!receipt) {
        return { isValid: false, invalidReason: "Transaction not found" };
      }

      if (receipt.status !== "success") {
        return { isValid: false, invalidReason: "Transaction failed" };
      }

      const payer: Address = receipt.from;

      // Fetch the transaction to validate calldata (amount + recipient)
      const tx = await getTransaction(this.client, txHash as `0x${string}`);
      if (!tx) {
        return { isValid: false, invalidReason: "Transaction data not found" };
      }

      // Validate transfer amount from calldata.
      // Token::transfer layout: 4-byte selector + 32-byte AccountId + 16-byte u128 LE amount
      // Total = 52 bytes = 104 hex chars + "0x" prefix
      const input = tx.input;
      if (input.length < 106) {
        return { isValid: false, invalidReason: "Transaction calldata too short for token transfer" };
      }

      // Amount is bytes [36..52] encoded as u128 little-endian
      const amountHex = input.slice(2 + 72); // skip "0x" + 4-byte selector (8) + 32-byte accountId (64)
      const amountBytes = new Uint8Array(16);
      for (let i = 0; i < 16; i++) {
        amountBytes[i] = Number.parseInt(amountHex.slice(i * 2, i * 2 + 2), 16);
      }
      let transferAmount = 0n;
      for (let i = 15; i >= 0; i--) {
        transferAmount = (transferAmount << 8n) | BigInt(amountBytes[i]);
      }

      const requiredAmount = BigInt(paymentRequirements.amount);
      if (transferAmount < requiredAmount) {
        return {
          isValid: false,
          invalidReason: `Insufficient payment: got ${transferAmount}, need ${requiredAmount}`,
        };
      }

      return { isValid: true, payer };
    } catch (err) {
      console.error("Payment verification failed:", err);
      return { isValid: false, invalidReason: "Verification failed" };
    }
  }

  async settle(
    paymentPayload: PaymentPayload,
    _paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const txHash = paymentPayload.payload.txHash as string;

    // Mark as used only on settlement (after handler succeeds)
    this.usedTxHashes.set(txHash, Date.now());

    // Retrieve the real sender from the receipt
    let payer = txHash;
    try {
      const receipt = await getTransactionReceipt(this.client, txHash as `0x${string}`);
      if (receipt) payer = receipt.from;
    } catch {
      // Non-fatal — we already verified in verify(), use txHash as fallback
    }

    return {
      success: true,
      transaction: txHash,
      network: this.network,
      payer,
    };
  }

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: this.network,
        },
      ],
      extensions: [],
      signers: {},
    };
  }
}
