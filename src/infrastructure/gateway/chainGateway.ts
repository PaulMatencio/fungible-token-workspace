/**
 * Wallet Mode adapter: builds, proves, balances and submits real transactions
 * through midnight-js and the connected wallet (Lace / 1AM).
 */
import { deployContract, findDeployedContract, submitInsertVerifierKeyTx } from '@midnight-ntwrk/midnight-js-contracts';
import type { ApprovalSlotInput, DeployParams, TokenGateway, TxLogEntry } from '@/application/ports';
import { AppError, compactText, deepMessage } from '@/domain/errors';
import { bytesToHex, hex32ToBytes } from '@/domain/hex';
import type { ApprovalFile, MultisigOp } from '@/domain/multisig';
import type { TokenState, TxReceipt } from '@/domain/token';
import { contractConfig } from '../config/network';
import { allCircuitIds, makeCompiledContract } from '../contract/compiled';
import { ledger } from '../contract/module';
import { pointFromJson, randomBytes } from '../crypto/signing';
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import { activeSink } from '@/application/deployProgress';
import { heldBalance, nativeColorHex } from '../contract/token';
import { hexToWalletAddress } from '../wallet/address';
import { indexerUnshieldedBalance } from '../indexer/unshieldedBalance';
import { fetchContractHistory } from '../indexer/contractHistory';
import type { AppProviders } from '../wallet/providers';
import { padApprovals } from './simulatorGateway';

type CallTx = Record<string, (...args: unknown[]) => Promise<{ public: { txId: string; txHash: string; blockHeight: number } }>>;
interface Found {
  callTx: CallTx;
  deployTxData: { public: { contractAddress: string; txId: string; txHash: string; blockHeight: number } };
}

/** Walks the cause chain: midnight-js wraps the real failure (proof server, wallet, node) several layers deep. */
function describeError(e: unknown): string {
  const parts: string[] = [];
  for (let c: unknown = e, i = 0; c && i < 5; i++) {
    parts.push(c instanceof Error ? `${c.name}: ${c.message}` : typeof c === 'object' ? deepMessage(c).join(' ← ') : String(c));
    c = (c as { cause?: unknown }).cause;
  }
  // Drop a cause whose text the outer message already contains (stage() wraps the original error).
  const kept = parts.filter((part, i) => !parts.slice(0, i).some((outer) => outer.includes(part.replace(/^[A-Za-z]*Error: /, ''))));
  return compactText(kept.join(' ← '));
}

const toReceipt = (r: { public: { txId: string; txHash: string; blockHeight: number } }): TxReceipt => ({
  txId: String(r.public.txId),
  txHash: r.public.txHash,
  blockHeight: r.public.blockHeight
});

/** The connected wallet: its API, its own unshielded address (64 hex) and the network (for Bech32m encoding). */
export interface WalletCtx {
  api: ConnectedAPI;
  walletHex: string;
  networkId: string;
}

/**
 * Circuits registered on a contract that this app's compiled contract doesn't have. Same-named circuits of another
 * contract version have different verifier keys, so midnight-js would fail with a confusing "mismatched verifier keys";
 * detecting foreign circuits first gives a clear answer.
 */
export function foreignCircuits(registered: Iterable<string>, known: readonly string[]): string[] {
  return [...registered].filter((c) => !known.includes(c));
}

export class ChainGateway implements TokenGateway {
  readonly mode = 'wallet' as const;

  private constructor(
    readonly contractAddress: string,
    private found: Found,
    private readonly providers: AppProviders,
    private readonly getSecretKey: () => Uint8Array,
    private readonly wallet: WalletCtx
  ) {}

  /** Circuit names whose verifier key is currently registered on-chain. */
  private static async registered(providers: AppProviders, address: string): Promise<Set<string>> {
    const s = await providers.publicDataProvider.queryContractState(address);
    if (!s) throw new AppError('CONTRACT_REJECTED', 'Contract state not found on this network');
    return new Set(s.operations().map((o: unknown) => (typeof o === 'string' ? o : new TextDecoder().decode(o as Uint8Array))));
  }

  /**
   * Opens the contract with exactly the circuits that are registered on-chain. midnight-js verifies that every
   * circuit of the contract definition it is given has a matching on-chain verifier key, so handing it the full
   * definition while some keys are still pending (staged deploy) would fail with "…undefined or have mismatched
   * verifier keys".
   */
  private static async open(providers: AppProviders, address: string, getSecretKey: () => Uint8Array): Promise<Found> {
    const have = await ChainGateway.registered(providers, address);
    const all = allCircuitIds();
    const foreign = foreignCircuits(have, all);
    if (foreign.length > 0) {
      throw new AppError(
        'CONTRACT_VERSION',
        `Contract ${address.slice(0, 10)}… is a different version of this token (it has circuits this app does not know: ${foreign.join(', ')}). It is a v2.6 contract — open it in the v2.6 app at http://localhost:3001 (the v2.6 project, fungible-token-workspace-v2.6). Nothing was changed.`
      );
    }
    const subset = all.every((c) => have.has(c)) ? undefined : all.filter((c) => have.has(c));
    return (await (findDeployedContract as unknown as (p: unknown, o: unknown) => Promise<Found>)(providers, {
      contractAddress: address,
      compiledContract: makeCompiledContract(getSecretKey, subset)
    })) as Found;
  }

  static async deploy(
    providers: AppProviders,
    params: DeployParams,
    ownerAccount: string,
    getSecretKey: () => Uint8Array,
    wallet: WalletCtx
  ): Promise<{ gateway: ChainGateway; receipt: TxReceipt; salt: string }> {
    const salt = params.salt ?? bytesToHex(randomBytes(32));
    // Only the core circuits' verifier keys go into the deploy transaction (see contractConfig.deployCircuits).
    const compiledContract = makeCompiledContract(getSecretKey, params.deployCircuits ?? contractConfig.deployCircuits);
    try {
      const deployed = (await (deployContract as unknown as (p: unknown, o: unknown) => Promise<Found>)(providers, {
        compiledContract,
        args: [
          hex32ToBytes(salt, 'salt'),
          hex32ToBytes(ownerAccount, 'owner'),
          hex32ToBytes(params.treasury, 'treasury'),
          params.name,
          params.symbol,
          BigInt(params.decimals),
          params.maxSupply,
          params.signerCommitments.map((c) => hex32ToBytes(c, 'signer commitment')),
          BigInt(params.threshold)
        ]
      })) as Found;
      const d = deployed.deployTxData.public;
      // Re-open with the FULL contract so every circuit is callable once its key is registered.
      let gateway: ChainGateway;
      try {
        gateway = await ChainGateway.connect(providers, d.contractAddress, getSecretKey, wallet);
      } catch (e) {
        // The deploy itself succeeded; never lose the address.
        throw new AppError('CONTRACT_REJECTED', `Contract deployed at ${d.contractAddress} (tx ${d.txHash}), but opening it failed: ${describeError(e)}. Attach to that address to continue.`, { cause: e });
      }
      return {
        gateway,
        receipt: { txId: String(d.txId), txHash: d.txHash, blockHeight: d.blockHeight },
        salt
      };
    } catch (e) {
      console.error('[deploy] failed', e);
      throw new AppError('CONTRACT_REJECTED', describeError(e), { cause: e });
    }
  }

  static async connect(providers: AppProviders, contractAddress: string, getSecretKey: () => Uint8Array, wallet: WalletCtx): Promise<ChainGateway> {
    const found = await ChainGateway.open(providers, contractAddress, getSecretKey);
    return new ChainGateway(contractAddress, found, providers, getSecretKey, wallet);
  }

  private async raw() {
    const s = await this.providers.publicDataProvider.queryContractState(this.contractAddress);
    if (!s) throw new AppError('CONTRACT_REJECTED', 'Contract state not found on this network');
    return ledger(s.data);
  }

  private async call(circuit: string, ...args: unknown[]): Promise<TxReceipt> {
    const fn = this.found.callTx[circuit];
    if (!fn) {
      throw new AppError('VALIDATION', `Circuit “${circuit}” is not registered on-chain yet. Use “Register remaining circuits” on the Overview tab first.`);
    }
    try {
      return toReceipt(await fn(...args));
    } catch (e) {
      console.error(`[${circuit}] failed`, e);
      throw new AppError('CONTRACT_REJECTED', describeError(e), { cause: e });
    }
  }

  /** Circuits of the compiled contract whose verifier key is not on-chain yet. */
  async missingCircuits(): Promise<string[]> {
    const have = await ChainGateway.registered(this.providers, this.contractAddress);
    return allCircuitIds().filter((c) => !have.has(c));
  }

  /** One maintenance transaction: inserts a circuit's verifier key (signed with the deploy-time authority key). */
  async registerCircuit(circuit: string): Promise<TxReceipt> {
    if (!allCircuitIds().includes(circuit)) throw new AppError('VALIDATION', `Unknown circuit ${circuit}`);
    try {
      const vk = await this.providers.zkConfigProvider.getVerifierKey(circuit);
      // Needs the FULL definition (the circuit isn't in the currently opened subset) and the deploy-time authority key,
      // which midnight-js reads from the private-state provider.
      const submit = (submitInsertVerifierKeyTx as unknown as (...a: unknown[]) => Promise<{ txId?: string; txHash: string; blockHeight: number }>)(
        this.providers,
        makeCompiledContract(this.getSecretKey),
        this.contractAddress,
        circuit,
        vk
      );
      submit.catch(() => {}); // a late rejection after the chain already confirmed must not surface as unhandled
      // midnight-js waits for the indexer to report the tx; that wait can stall even though the tx is final
      // (observed on preprod). Treat the chain's own state as the source of truth.
      const stop = { done: false };
      const confirmed = this.pollRegistered(circuit, stop);
      confirmed.catch(() => {});
      let r: Awaited<typeof submit> | null;
      try {
        r = (await Promise.race([submit.then((x) => ({ r: x })), confirmed.then(() => ({ r: null }))])).r;
      } finally {
        stop.done = true; // stop polling once we have an outcome
      }
      // The circuit is now registered: reopen so it becomes callable.
      this.found = await ChainGateway.open(this.providers, this.contractAddress, this.getSecretKey);
      return r
        ? { txId: String(r.txId ?? r.txHash), txHash: r.txHash, blockHeight: r.blockHeight }
        : { txId: '', txHash: '(confirmed from chain state)' };
    } catch (e) {
      console.error(`[register ${circuit}] failed`, e);
      throw new AppError('CONTRACT_REJECTED', describeError(e), { cause: e });
    }
  }

  /** Resolves when `circuit`'s verifier key shows up on-chain; rejects after `timeoutMs` (default 10 min). */
  private async pollRegistered(circuit: string, stop: { done: boolean }, timeoutMs = 10 * 60_000, everyMs = 4_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && !stop.done) {
      await new Promise((r) => setTimeout(r, everyMs));
      try {
        if ((await ChainGateway.registered(this.providers, this.contractAddress)).has(circuit)) return;
      } catch {
        /* node/indexer hiccup: keep polling */
      }
    }
    if (stop.done) return;
    throw new AppError('CONTRACT_REJECTED', `Registering “${circuit}” was not confirmed on-chain within ${Math.round(timeoutMs / 60_000)} minutes. Check your wallet's history for a pending transaction, then use “Register remaining circuits” again.`);
  }

  /** Every deploy / maintenance / call of this contract as recorded by the indexer, as history rows. */
  async chainHistory(): Promise<TxLogEntry[]> {
    const cfg = await this.wallet.api.getConfiguration();
    const actions = await fetchContractHistory(cfg.indexerWsUri, this.contractAddress);
    return actions.map((a) => ({
      id: `${a.txHash}:${a.circuit}`,
      contractAddress: this.contractAddress,
      circuit: a.circuit,
      txHash: a.txHash,
      txId: '',
      blockHeight: a.blockHeight,
      status: 'finalized' as const,
      at: a.at,
      mode: 'wallet' as const
    }));
  }

  async getState(): Promise<TokenState> {
    const cs = await this.providers.publicDataProvider.queryContractState(this.contractAddress);
    if (!cs) throw new AppError('CONTRACT_REJECTED', 'Contract state not found on this network');
    const l = ledger(cs.data);
    const color = nativeColorHex(this.contractAddress);
    // Contract-held tokens live in the ledger's ContractState balance, which is authoritative. The indexer's
    // per-contract `unshieldedBalances` field stays empty after a deposit (verified on preprod), so it is only a
    // fallback for a state that carries no entry. Wallet balances use the UTXO history instead (see walletBalance).
    let held = heldBalance(cs.balance as unknown as Map<unknown, bigint>, color);
    if (held === 0n) {
      try {
        const utxo = await this.providers.publicDataProvider.queryUnshieldedBalances(this.contractAddress);
        const hit = utxo?.find((b) => String(b.tokenType).toLowerCase() === color);
        if (hit) held = hit.balance;
      } catch (e) {
        console.warn('[state] indexer unshielded balances unavailable', e);
      }
    }
    return {
      contractAddress: this.contractAddress,
      name: l._name,
      symbol: l._symbol,
      decimals: Number(l._decimals),
      totalSupply: l._totalSupply,
      maxSupply: l._maxSupply,
      owner: bytesToHex(l.owner),
      treasury: bytesToHex(l.treasury),
      tokenColor: color,
      contractBalance: held,
      contractSalt: bytesToHex(l._contractSalt),
      paused: l._paused,
      emergencyPauser: bytesToHex(l._emergencyPauser),
      multisigThreshold: Number(l._multisigThreshold),
      multisigSignerCount: Number(l._multisigSignerCount),
      multisigNonce: l._multisigNonce,
      signerCommitments: [...l._multisigSigners].map(bytesToHex)
    };
  }

  /**
   * Any wallet's balance, read from the indexer's unshielded UTXO history (created − spent). Falls back to the
   * wallet API for the connected wallet if the indexer replay fails.
   */
  async walletBalance(address: string): Promise<bigint> {
    const color = nativeColorHex(this.contractAddress);
    const own = address.toLowerCase() === this.wallet.walletHex.toLowerCase();
    try {
      const cfg = await this.wallet.api.getConfiguration();
      const bech = await hexToWalletAddress(address, this.wallet.networkId);
      return await indexerUnshieldedBalance(cfg.indexerWsUri, bech, color);
    } catch (e) {
      if (!own) throw new AppError('CONTRACT_REJECTED', `Could not read the balance from the indexer: ${describeError(e)}`, { cause: e });
      console.warn('[balance] indexer UTXO read failed, using wallet API', e);
      const balances = await this.wallet.api.getUnshieldedBalances();
      return balances[color] ?? 0n;
    }
  }

  /**
   * Wallet → wallet transfer: the wallet builds, signs and submits a native unshielded transfer. No contract circuit
   * and no ZK proof are involved, and `pause` cannot stop it.
   */
  async transferNative(_from: string, to: string, value: bigint): Promise<TxReceipt> {
    const recipient = await hexToWalletAddress(to, this.wallet.networkId);
    try {
      activeSink.begin('balance');
      const { tx } = await this.wallet.api.makeTransfer(
        [{ kind: 'unshielded', type: nativeColorHex(this.contractAddress), value, recipient }],
        { payFees: true }
      );
      activeSink.done('balance');
      activeSink.begin('submit');
      await this.wallet.api.submitTransaction(tx);
      activeSink.done('submit');
      activeSink.begin('confirm');
    } catch (e) {
      console.error('[transfer] failed', e);
      throw new AppError('CONTRACT_REJECTED', describeError(e), { cause: e });
    }
    return { txId: '', txHash: '(submitted by your wallet)' };
  }

  /** Wallet → contract-held balance. The wallet funds the unshielded inputs the circuit's `receiveUnshielded` needs. */
  deposit = (_from: string, value: bigint) => this.call('deposit', value);
  pause = (caller: string) => this.call('pause', hex32ToBytes(caller));
  unpause = (caller: string) => this.call('unpause', hex32ToBytes(caller));
  emergencyWithdraw = (caller: string, value: bigint) => this.call('emergencyWithdraw', hex32ToBytes(caller), value);

  async executeMultisig(op: MultisigOp, approvals: ApprovalFile[], pop?: ApprovalFile) {
    const { pubkeys, signatures } = padApprovals(approvals);
    switch (op.type) {
      case 'mint':
        return this.call('mint', hex32ToBytes(op.to, 'to'), BigInt(op.value), pubkeys, signatures);
      case 'burn':
        return this.call('burn', BigInt(op.value), pubkeys, signatures);
      case 'contractWithdraw':
        return this.call('contractWithdraw', hex32ToBytes(op.to, 'to'), BigInt(op.value), pubkeys, signatures);
      case 'setEmergencyPauser':
        return this.call('setEmergencyPauser', hex32ToBytes(op.newPauser, 'newPauser'), pubkeys, signatures);
      case 'rotateSigner': {
        if (!pop) throw new AppError('VALIDATION', 'rotateSigner needs the incoming signer’s proof-of-possession');
        const s: ApprovalSlotInput['signature'] = pop.signature;
        return this.call(
          'rotateSigner',
          hex32ToBytes(op.oldSignerCommitment, 'oldSignerCommitment'),
          pointFromJson(op.newSignerPubkey),
          { announcement: pointFromJson(s.announcement), response: BigInt(s.response) },
          pubkeys,
          signatures
        );
      }
    }
  }
}
