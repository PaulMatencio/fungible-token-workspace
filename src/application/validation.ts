import { MAX_UINT128, parseAmount } from '@/domain/amount';
import { AppError } from '@/domain/errors';
import { isHex32 } from '@/domain/hex';
import type { DeployParams } from './ports';

const bad = (m: string): never => {
  throw new AppError('VALIDATION', m);
};

export function requireAccount(v: string, label: string): string {
  const raw = v.trim();
  // A Midnight wallet address (Bech32m: mn_addr_…, mn_shield-addr_…, mn_dust_…) is NOT a token account.
  if (/^mn_[a-z0-9_-]+1[02-9ac-hj-np-z]{6,}$/i.test(raw) || raw.toLowerCase().startsWith('mn_')) {
    bad(`${label}: that is a wallet address. This field takes a manager token account (64 hex, from the app’s Your identity card), not a wallet address.`);
  }
  const t = raw.replace(/^0x/, '').toLowerCase();
  if (!isHex32(t)) bad(`${label}: expected a 64-character hex account`);
  return t;
}

/**
 * A wallet address as 64-hex UserAddress bytes (what the contract takes). The UI converts Bech32m (`mn_addr_…`) to
 * hex before calling services (see infrastructure/wallet/address.ts); this only validates the final form.
 */
export function requireWalletAddress(v: string, label: string, contractAddress?: string): string {
  const raw = v.trim();
  if (raw.toLowerCase().startsWith('mn_')) {
    bad(`${label}: Bech32m address not converted — paste a Midnight unshielded address (mn_addr_…) into the address field`);
  }
  const t = raw.replace(/^0x/, '').toLowerCase();
  if (!isHex32(t)) bad(`${label}: expected a Midnight unshielded wallet address (mn_addr_…) or its 64 hex characters`);
  if (/^0{64}$/.test(t)) bad(`${label}: the all-zero address is not allowed`);
  // A contract address is also 32 bytes, so the circuits would accept it as a wallet — but the tokens would land on an
  // address nobody holds a key for and be lost for good.
  if (contractAddress && t === contractAddress.toLowerCase().replace(/^0x/, '')) {
    bad(`${label}: that is the token CONTRACT's own address, not a wallet. Tokens sent there are lost forever (no one holds its key). To put tokens in the contract, send them to your own wallet and use “Deposit to the contract”.`);
  }
  return t;
}

export function requireAmount(v: string, decimals: number, label = 'Amount'): bigint {
  let n: bigint;
  try {
    n = parseAmount(v, decimals);
  } catch (e) {
    return bad(`${label}: ${(e as Error).message}`);
  }
  if (n <= 0n) bad(`${label} must be greater than zero`);
  if (n > MAX_UINT128) bad(`${label} is too large`);
  return n;
}

export interface DeployForm {
  name: string;
  symbol: string;
  decimals: string;
  maxSupply: string;
  threshold: string;
  /** Three cosigner public keys as JSON `{"x":"…","y":"…"}` or `x,y`. */
  signerPubkeys: [string, string, string];
  /** Wallet that emergencyWithdraw pays — 64 hex UserAddress bytes (UI converts from mn_addr_…). */
  treasury: string;
}

export function parsePubkey(s: string): { x: string; y: string } {
  const t = s.trim();
  try {
    if (t.startsWith('{')) {
      const j = JSON.parse(t) as { x?: string; y?: string };
      if (/^\d+$/.test(String(j.x)) && /^\d+$/.test(String(j.y))) return { x: String(j.x), y: String(j.y) };
    } else {
      const [x, y] = t.split(/[\s,]+/);
      if (/^\d+$/.test(x ?? '') && /^\d+$/.test(y ?? '')) return { x, y };
    }
  } catch {
    /* fallthrough */
  }
  return bad('Public key must be {"x":"…","y":"…"} (decimal), as printed by signer-tool keygen');
}

/** Validates the deploy form and derives salted signer commitments. */
export function buildDeployParams(
  f: DeployForm,
  commitmentFor: (pk: { x: string; y: string }, salt: string) => string,
  saltHex: string
): DeployParams {
  if (!f.name.trim() || f.name.length > 64) bad('Name is required (max 64 characters)');
  if (!/^[A-Za-z0-9]{1,12}$/.test(f.symbol.trim())) bad('Symbol: 1–12 letters/digits');
  const decimals = Number(f.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) bad('Decimals must be 0–255');
  const threshold = Number(f.threshold);
  if (![1, 2, 3].includes(threshold)) bad('Threshold must be 1, 2 or 3');
  let maxSupply = 0n;
  if (f.maxSupply.trim() !== '' && f.maxSupply.trim() !== '0') maxSupply = requireAmount(f.maxSupply, decimals, 'Max supply');
  const commitments = f.signerPubkeys.map((p) => commitmentFor(parsePubkey(p), saltHex));
  if (new Set(commitments).size !== 3) bad('The three cosigner keys must be distinct');
  const treasury = requireWalletAddress(f.treasury, 'Treasury');
  return {
    treasury,
    name: f.name.trim(),
    symbol: f.symbol.trim(),
    decimals,
    maxSupply,
    threshold: threshold as 1 | 2 | 3,
    signerCommitments: commitments as [string, string, string],
    salt: saltHex
  };
}
