import type { Hex } from "viem";
import { bytesToHex, hexToBytes, keccak256, toBytes } from "viem";
import { generatePrivateKey } from "viem/accounts";

// Hardhat accounts #3-#19 private keys (17 agent wallets)
export const HARDHAT_AGENT_KEYS: Hex[] = [
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // #3
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // #4
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // #5
  "0x92db14e403b83dfe3df233f83dfa3ecda7b66277101571b642875e5aba2be7b8", // #6
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356", // #7
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97", // #8
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6", // #9
  "0xf214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897", // #10
  "0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82", // #11
  "0xa267530f49f8280200edf313ee7af6b827f2a8bce2897751d06a843f644967b1", // #12
  "0x47c99abed3324a2707c28affff1267e45918ec8c3f20b8aa892e8b065d2942dd", // #13
  "0xc526ee95bf44d8fc405a158bb884d9d1238d99f0612e9f33d006bb0789009aaa", // #14
  "0x8166f546bab6da521a8369cab06c5d2b9e46670292d85c875ee9ec20e84ffb61", // #15
  "0xea6c44ac03bff858b476bba40716402b03e41b8e97e276d1baec7c37d42484a0", // #16
  "0x689af8efa8c651a91ad287602527f3af2fe9f6501a7ac4b061667b5a93e037fd", // #17
  "0xde9be858da4a475276426320d5e9262ecfc3ba460bfac56360bfa6c4c28b4ee0", // #18
  "0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e", // #19
];

export function getAgentPrivateKeys(agentCount: number): Hex[] {
  const keys = [...HARDHAT_AGENT_KEYS];
  while (keys.length < agentCount) {
    keys.push(generatePrivateKey());
  }
  return keys.slice(0, agentCount);
}

/**
 * Encode a u128 as 16-byte little-endian (Borsh encoding for u128).
 */
export function u128ToLeBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(16);
  let v = value;
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

/**
 * Build a 32-byte AccountId from a simple integer (big-endian, zero-padded).
 * Used for well-known genesis accounts like Token (id=65535).
 */
export function accountIdFromInt(id: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let v = id;
  for (let i = 31; i >= 0; i -= 1) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

/**
 * derive_runtime_contract_address: AccountId → Ethereum address.
 * keccak256("contract:addr:runtime:v1" + account_id_32_bytes)[12..32]
 */
export function accountIdToAddress(accountId: Uint8Array): `0x${string}` {
  const prefix = toBytes("contract:addr:runtime:v1");
  const preimage = new Uint8Array(prefix.length + 32);
  preimage.set(prefix, 0);
  preimage.set(accountId, prefix.length);
  const hash = hexToBytes(keccak256(preimage));
  return bytesToHex(hash.slice(12, 32)) as `0x${string}`;
}

/**
 * derive_eth_eoa_account_id: Ethereum address → 32-byte AccountId.
 * keccak256("eoa:eth:v1" + address_20_bytes) → [u8; 32]
 */
export function addressToAccountId(address: `0x${string}`): Uint8Array {
  const prefix = toBytes("eoa:eth:v1");
  const addrBytes = hexToBytes(address);
  const preimage = new Uint8Array(prefix.length + 20);
  preimage.set(prefix, 0);
  preimage.set(addrBytes, prefix.length);
  return hexToBytes(keccak256(preimage));
}

/**
 * Build Token::transfer calldata.
 * Selector: keccak256("transfer")[0..4]
 * Args (Borsh): AccountId ([u8; 32]) + amount (u128 little-endian)
 * Total: 4 + 32 + 16 = 52 bytes
 */
export function buildTransferData(toAccountId: Uint8Array, amount: bigint): `0x${string}` {
  const selector = keccak256(toBytes("transfer")).slice(0, 10); // "0x" + 4 hex bytes
  const selectorBytes = hexToBytes(selector as `0x${string}`);
  const amountBytes = u128ToLeBytes(amount);
  const data = new Uint8Array(4 + 32 + 16);
  data.set(selectorBytes, 0);
  data.set(toAccountId, 4);
  data.set(amountBytes, 36);
  return bytesToHex(data) as `0x${string}`;
}
