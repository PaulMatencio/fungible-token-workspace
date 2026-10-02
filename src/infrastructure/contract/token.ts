import { rawTokenType } from '@midnight-ntwrk/compact-runtime';
import { bytesToHex } from '@/domain/hex';
import { pad32 } from '../crypto/identity';

/** Domain separator the contract mints under — must equal `pad(32, "fungible-token:native")` in the .compact source. */
export const TOKEN_DOMAIN = 'fungible-token:native';

/** The native token's color for a contract: tokenType(domain, contractAddress), as 64 hex (the key wallets use). */
export function nativeColorHex(contractAddressHex: string): string {
  const c = rawTokenType(pad32(TOKEN_DOMAIN), contractAddressHex) as unknown;
  return typeof c === 'string' ? c.toLowerCase() : bytesToHex(c as Uint8Array);
}

/** Picks the contract-held amount of `colorHex` out of a ContractState `balance` map (keys are `{tag, raw}` objects). */
export function heldBalance(balance: Map<unknown, bigint>, colorHex: string): bigint {
  for (const [k, v] of balance) {
    const raw = typeof k === 'object' && k !== null ? (k as { raw?: unknown }).raw : k;
    const hex = typeof raw === 'string' ? raw.toLowerCase() : raw instanceof Uint8Array ? bytesToHex(raw) : '';
    if (hex === colorHex) return v;
  }
  return 0n;
}
