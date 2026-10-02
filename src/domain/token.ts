import type { Role } from './roles';

/** Snapshot of the public ledger of FungibleToken v2.6. */
export interface TokenState {
  contractAddress: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  maxSupply: bigint;
  /** 64-hex account of the Contract Manager (ledger `owner`, hash-derived from the manager's secret key). */
  owner: string;
  /** 64-hex UserAddress bytes of the wallet that `emergencyWithdraw` pays. */
  treasury: string;
  /** The native token's color (64 hex): tokenType("fungible-token:native", contract). */
  tokenColor: string;
  /** Tokens currently held by the contract itself (deposited / awaiting withdrawal). */
  contractBalance: bigint;
  contractSalt: string;
  paused: boolean;
  emergencyPauser: string;
  multisigThreshold: number;
  multisigSignerCount: number;
  multisigNonce: bigint;
  /** Signer commitments (64 hex) currently registered. */
  signerCommitments: string[];
}

export interface JubjubPointJson {
  x: string;
  y: string;
}

export interface TxReceipt {
  txId: string;
  txHash: string;
  blockHeight?: number;
}

export type CircuitName =
  | 'mint'
  | 'burn'
  | 'contractWithdraw'
  | 'setEmergencyPauser'
  | 'rotateSigner'
  | 'pause'
  | 'unpause'
  | 'deposit'
  | 'emergencyWithdraw';

export type Authority = 'holder' | 'pauser' | 'owner' | 'multisig';

export interface CircuitSpec {
  name: CircuitName;
  authority: Authority;
  /** Roles whose UI exposes this circuit. */
  roles: Role[];
  /** i18n key for the label. */
  labelKey: string;
}

/**
 * Which role sees which circuit. On-chain rules still decide; this only
 * organises the UI (the contract enforces authority itself).
 * - holder circuits (`authenticate(caller)`) work for anyone with tokens;
 * - pause/unpause: owner or emergency pauser;
 * - emergencyWithdraw: owner only, while paused;
 * - multisig circuits: assembled by the manager/cosigners with threshold approvals.
 */
export const CIRCUITS: readonly CircuitSpec[] = [
  { name: 'deposit', authority: 'holder', roles: ['user', 'cosigner', 'manager'], labelKey: 'op.deposit' },
  { name: 'pause', authority: 'pauser', roles: ['manager'], labelKey: 'op.pause' },
  { name: 'unpause', authority: 'pauser', roles: ['manager'], labelKey: 'op.unpause' },
  { name: 'emergencyWithdraw', authority: 'owner', roles: ['manager'], labelKey: 'op.emergencyWithdraw' },
  { name: 'mint', authority: 'multisig', roles: ['manager', 'cosigner'], labelKey: 'op.mint' },
  { name: 'burn', authority: 'multisig', roles: ['manager', 'cosigner'], labelKey: 'op.burn' },
  { name: 'contractWithdraw', authority: 'multisig', roles: ['manager', 'cosigner'], labelKey: 'op.contractWithdraw' },
  { name: 'setEmergencyPauser', authority: 'multisig', roles: ['manager', 'cosigner'], labelKey: 'op.setEmergencyPauser' },
  { name: 'rotateSigner', authority: 'multisig', roles: ['manager', 'cosigner'], labelKey: 'op.rotateSigner' }
];

export const circuitsForRole = (role: Role): CircuitSpec[] => CIRCUITS.filter((c) => c.roles.includes(role));
