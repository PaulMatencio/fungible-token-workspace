import type { ApprovalFile, MultisigOp, SigningRequest } from '@/domain/multisig';
import type { JubjubPointJson, TokenState, TxReceipt } from '@/domain/token';

export interface ApprovalSlotInput {
  publicKey: JubjubPointJson;
  signature: { announcement: JubjubPointJson; response: string };
}

export interface DeployParams {
  name: string;
  symbol: string;
  decimals: number;
  /** 0n = uncapped. */
  maxSupply: bigint;
  /** 64-hex signer commitments (exactly 3). */
  signerCommitments: [string, string, string];
  threshold: 1 | 2 | 3;
  /** 64-hex UserAddress bytes of the wallet that `emergencyWithdraw` pays. */
  treasury: string;
  /** Optional: 64-hex salt; random when omitted. */
  salt?: string;
  /** Wallet Mode: circuits carried by the deploy transaction (default from midnight.config.json). */
  deployCircuits?: string[];
}

/**
 * Port: everything the app does against a FungibleToken instance. Two
 * adapters exist — a local simulator (Test Mode) and an on-chain client
 * (Wallet Mode). Identity-bound methods take the caller's 64-hex account;
 * the adapter's identity provider supplies the matching secret key.
 */
export interface TokenGateway {
  readonly mode: 'test' | 'wallet';
  readonly contractAddress: string;

  getState(): Promise<TokenState>;

  /**
   * Native-token balance of a wallet (64-hex UserAddress bytes). Test Mode knows every mock wallet; Wallet Mode can
   * only read the connected wallet's own balance (other wallets' balances are not exposed by the wallet API).
   */
  walletBalance(address: string): Promise<bigint>;

  /**
   * Wallet → wallet transfer of the native token. Done by the wallet itself (Lace / 1AM `makeTransfer`), not by a
   * contract circuit. `from` is the sender's wallet address (used by the simulator; the real wallet signs for itself).
   */
  transferNative(from: string, to: string, value: bigint): Promise<TxReceipt>;

  /** Wallet → contract-held balance (treasury → contract). */
  deposit(from: string, value: bigint): Promise<TxReceipt>;
  pause(caller: string): Promise<TxReceipt>;
  unpause(caller: string): Promise<TxReceipt>;
  /** Owner only, while paused: contract-held tokens → the fixed treasury wallet. */
  emergencyWithdraw(caller: string, value: bigint): Promise<TxReceipt>;

  /** Wallet Mode only: circuits whose verifier key is not yet on-chain (staged deploy). */
  missingCircuits?(): Promise<string[]>;
  /** Wallet Mode only: every on-chain action of this contract (from the indexer), as history rows. */
  chainHistory?(): Promise<TxLogEntry[]>;
  /** Wallet Mode only: registers one missing circuit's verifier key (one maintenance transaction). */
  registerCircuit?(circuit: string): Promise<TxReceipt>;

  /** Multisig-governed: `approvals` are signer-tool approval files (1–3). */
  executeMultisig(op: MultisigOp, approvals: ApprovalFile[], pop?: ApprovalFile): Promise<TxReceipt>;
}

export type { SigningRequest };

export interface TxLogEntry {
  id: string;
  contractAddress: string;
  circuit: string;
  txHash: string;
  txId: string;
  blockHeight?: number;
  status: 'submitted' | 'finalized' | 'failed';
  error?: string;
  at: number;
  mode: 'test' | 'wallet';
}

/** Persistence port so transactions and identities survive reloads ("must be persistent"). */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

export interface ToolingPort {
  run(action: ToolingAction, params?: Record<string, unknown>): Promise<ToolingResult>;
}

export type ToolingAction = 'compile' | 'generate-sdk' | 'generate-tests' | 'run-tests' | 'status';

export interface ToolingResult {
  ok: boolean;
  action: ToolingAction;
  durationMs: number;
  log: string;
  /** Present for run-tests. */
  tests?: TestSummary;
  files?: string[];
  status?: ToolingStatus;
}

export interface ToolingStatus {
  compiled: boolean;
  compilerVersion?: string;
  circuits: string[];
  sdkGenerated: boolean;
  testsGenerated: boolean;
  managedDir: string;
  enabled: boolean;
}

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  cases: { name: string; status: 'passed' | 'failed' | 'skipped'; message?: string; durationMs?: number }[];
}

/** Crypto operations the application needs, implemented by infrastructure. */
export interface SignerCrypto {
  computeDigest(req: SigningRequest): Uint8Array;
  verifyApproval(req: SigningRequest, f: ApprovalFile): { ok: true } | { ok: false; reason: string };
  commitmentFor(pk: JubjubPointJson, saltHex: string): string;
  randomSaltHex(): string;
}

export interface TxLogPort {
  add(entry: TxLogEntry): Promise<void>;
  list(contractAddress?: string): Promise<TxLogEntry[]>;
}
