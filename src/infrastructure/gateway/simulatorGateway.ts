/**
 * Test Mode adapter for FungibleToken v3: executes the compiled circuits locally through the Compact runtime
 * (no network, no proofs). The runtime does not apply token movements to a ledger, so this adapter keeps its own
 * accounting for the contract-held balance and the mock wallets' balances and applies each successful call's effect.
 */
import {
  ContractState,
  createCircuitContext,
  createConstructorContext,
  type CircuitContext
} from '@midnight-ntwrk/compact-runtime';
import type { ApprovalSlotInput, DeployParams, TokenGateway } from '@/application/ports';
import { AppError } from '@/domain/errors';
import { bytesToHex, hex32ToBytes } from '@/domain/hex';
import type { ApprovalFile, MultisigOp } from '@/domain/multisig';
import type { TokenState, TxReceipt } from '@/domain/token';
import { Contract, ledger } from '../contract/module';
import { createWitnesses } from '../contract/witnesses';
import { nativeColorHex } from '../contract/token';
import { IDENTITY_POINT, pointFromJson, randomBytes } from '../crypto/signing';

const ZERO_COIN_PK = '00'.repeat(32);

export type SecretKeyResolver = (account: string) => Uint8Array;

/** JSON-safe record of a successful call, used to rebuild state (incl. balances) after a reload. */
export type ReplayOp =
  | { kind: 'holder'; circuit: 'deposit' | 'pause' | 'unpause' | 'emergencyWithdraw' | 'transfer'; caller: string; args: string[] }
  | { kind: 'multisig'; op: MultisigOp; approvals: ApprovalFile[]; pop?: ApprovalFile };

export interface SimulatorSnapshot {
  version: 2;
  contractAddress: string;
  owner: string;
  params: Omit<DeployParams, 'maxSupply'> & { maxSupply: string; salt: string };
  ops: ReplayOp[];
}

export class SimulatorGateway implements TokenGateway {
  readonly mode = 'test' as const;
  private ctx: CircuitContext<undefined>;
  private activeSk: Uint8Array = new Uint8Array(32);
  private readonly contract: Contract<undefined>;
  private counter = 0;
  private ops: ReplayOp[] = [];
  /** Tokens held by the contract (the runtime does not track this). */
  private held = 0n;
  /** Mock wallets: 64-hex UserAddress → native balance. */
  private wallets = new Map<string, bigint>();
  private readonly color: string;
  private readonly treasuryHex: string;

  private constructor(
    readonly contractAddress: string,
    ctx: CircuitContext<undefined>,
    private readonly resolveSk: SecretKeyResolver,
    private readonly meta: Pick<SimulatorSnapshot, 'owner' | 'params'>
  ) {
    this.ctx = ctx;
    this.contract = new Contract<undefined>(createWitnesses(() => this.activeSk));
    this.color = nativeColorHex(contractAddress);
    this.treasuryHex = meta.params.treasury;
  }

  /** Deploys a fresh in-memory instance owned by `ownerAccount`. */
  static async deploy(
    params: DeployParams,
    ownerAccount: string,
    resolveSk: SecretKeyResolver,
    address: string = bytesToHex(randomBytes(32))
  ): Promise<SimulatorGateway> {
    const salt = params.salt ?? bytesToHex(randomBytes(32));
    const contract = new Contract<undefined>(createWitnesses(() => new Uint8Array(32)));
    const init = await contract.initialState(
      createConstructorContext(undefined, ZERO_COIN_PK),
      hex32ToBytes(salt, 'salt'),
      hex32ToBytes(ownerAccount, 'owner'),
      hex32ToBytes(params.treasury, 'treasury'),
      params.name,
      params.symbol,
      BigInt(params.decimals),
      params.maxSupply,
      params.signerCommitments.map((c) => hex32ToBytes(c, 'signer commitment')),
      BigInt(params.threshold)
    );
    const ctx = createCircuitContext<undefined>(address, ZERO_COIN_PK, init.currentContractState, init.currentPrivateState);
    return new SimulatorGateway(address, ctx, resolveSk, {
      owner: ownerAccount,
      params: { ...params, maxSupply: params.maxSupply.toString(), salt }
    });
  }

  /** Context whose contract state carries the held balance, so `unshieldedBalanceGte` sees it. */
  private contextWithBalance(): CircuitContext<undefined> {
    const cs = new ContractState();
    cs.data = this.ctx.currentQueryContext.state;
    cs.balance = new Map([[{ tag: 'unshielded' as const, raw: this.color }, this.held]]) as never;
    return createCircuitContext<undefined>(this.contractAddress, ZERO_COIN_PK, cs, undefined);
  }

  private async run<R>(
    desc: ReplayOp,
    call: (c: Contract<undefined>, ctx: CircuitContext<undefined>) => { result: R; context: CircuitContext<undefined> } | Promise<{ result: R; context: CircuitContext<undefined> }>,
    effect: () => void
  ): Promise<TxReceipt> {
    this.activeSk = desc.kind === 'holder' && desc.circuit !== 'deposit' && desc.circuit !== 'transfer' ? this.resolveSk(desc.caller) : new Uint8Array(32);
    try {
      const out = await call(this.contract, this.contextWithBalance());
      this.ctx = out.context;
    } catch (e) {
      throw new AppError('CONTRACT_REJECTED', (e as Error).message, { cause: e });
    } finally {
      this.activeSk = new Uint8Array(32);
    }
    effect();
    this.ops.push(desc);
    this.counter++;
    const hash = bytesToHex(randomBytes(32));
    return { txId: hash, txHash: hash, blockHeight: this.counter };
  }

  private raw() {
    return ledger(this.ctx.currentQueryContext.state);
  }

  snapshot(): SimulatorSnapshot {
    return { version: 2, contractAddress: this.contractAddress, owner: this.meta.owner, params: this.meta.params, ops: [...this.ops] };
  }

  /** Rebuilds an instance by replaying recorded calls (deterministic: same address, same signatures, same balances). */
  static async restore(snap: SimulatorSnapshot, resolveSk: SecretKeyResolver): Promise<SimulatorGateway> {
    const gw = await SimulatorGateway.deploy({ ...snap.params, maxSupply: BigInt(snap.params.maxSupply) }, snap.owner, resolveSk, snap.contractAddress);
    for (const o of snap.ops) {
      if (o.kind === 'multisig') await gw.executeMultisig(o.op, o.approvals, o.pop);
      else if (o.circuit === 'deposit') await gw.deposit(o.caller, BigInt(o.args[0]));
      else if (o.circuit === 'transfer') await gw.transferNative(o.caller, o.args[0], BigInt(o.args[1]));
      else if (o.circuit === 'pause') await gw.pause(o.caller);
      else if (o.circuit === 'unpause') await gw.unpause(o.caller);
      else await gw.emergencyWithdraw(o.caller, BigInt(o.args[0]));
    }
    return gw;
  }

  async getState(): Promise<TokenState> {
    const l = this.raw();
    return {
      contractAddress: this.contractAddress,
      name: l._name,
      symbol: l._symbol,
      decimals: Number(l._decimals),
      totalSupply: l._totalSupply,
      maxSupply: l._maxSupply,
      owner: bytesToHex(l.owner),
      treasury: bytesToHex(l.treasury),
      tokenColor: this.color,
      contractBalance: this.held,
      contractSalt: bytesToHex(l._contractSalt),
      paused: l._paused,
      emergencyPauser: bytesToHex(l._emergencyPauser),
      multisigThreshold: Number(l._multisigThreshold),
      multisigSignerCount: Number(l._multisigSignerCount),
      multisigNonce: l._multisigNonce,
      signerCommitments: [...l._multisigSigners].map(bytesToHex)
    };
  }

  async walletBalance(address: string): Promise<bigint> {
    return this.wallets.get(address.toLowerCase()) ?? 0n;
  }

  private credit(addr: string, v: bigint) {
    this.wallets.set(addr.toLowerCase(), (this.wallets.get(addr.toLowerCase()) ?? 0n) + v);
  }
  private debit(addr: string, v: bigint) {
    const have = this.wallets.get(addr.toLowerCase()) ?? 0n;
    if (have < v) throw new AppError('CONTRACT_REJECTED', `Insufficient wallet balance (have ${have}, need ${v})`);
    this.wallets.set(addr.toLowerCase(), have - v);
  }

  /** Native wallet → wallet transfer: pure accounting here (the real wallet does it on-chain). */
  async transferNative(from: string, to: string, value: bigint): Promise<TxReceipt> {
    this.debit(from, value);
    this.credit(to, value);
    this.ops.push({ kind: 'holder', circuit: 'transfer', caller: from, args: [to, value.toString()] });
    this.counter++;
    const hash = bytesToHex(randomBytes(32));
    return { txId: hash, txHash: hash, blockHeight: this.counter };
  }

  async deposit(from: string, value: bigint) {
    if ((this.wallets.get(from.toLowerCase()) ?? 0n) < value) throw new AppError('CONTRACT_REJECTED', 'Insufficient wallet balance to deposit');
    return this.run({ kind: 'holder', circuit: 'deposit', caller: from, args: [value.toString()] }, (c, x) => c.impureCircuits.deposit(x, value), () => {
      this.debit(from, value);
      this.held += value;
    });
  }
  async pause(caller: string) {
    return this.run({ kind: 'holder', circuit: 'pause', caller, args: [] }, (c, x) => c.impureCircuits.pause(x, hex32ToBytes(caller)), () => {});
  }
  async unpause(caller: string) {
    return this.run({ kind: 'holder', circuit: 'unpause', caller, args: [] }, (c, x) => c.impureCircuits.unpause(x, hex32ToBytes(caller)), () => {});
  }
  async emergencyWithdraw(caller: string, value: bigint) {
    return this.run({ kind: 'holder', circuit: 'emergencyWithdraw', caller, args: [value.toString()] }, (c, x) => c.impureCircuits.emergencyWithdraw(x, hex32ToBytes(caller), value), () => {
      this.held -= value;
      this.credit(this.treasuryHex, value);
    });
  }

  async executeMultisig(op: MultisigOp, approvals: ApprovalFile[], pop?: ApprovalFile) {
    const { pubkeys, signatures } = padApprovals(approvals);
    return this.run(
      { kind: 'multisig', op, approvals, pop },
      async (c, x) => {
        const k = c.impureCircuits;
        switch (op.type) {
          case 'mint':
            return k.mint(x, hex32ToBytes(op.to, 'to'), BigInt(op.value), pubkeys, signatures);
          case 'burn':
            return k.burn(x, BigInt(op.value), pubkeys, signatures);
          case 'contractWithdraw':
            return k.contractWithdraw(x, hex32ToBytes(op.to, 'to'), BigInt(op.value), pubkeys, signatures);
          case 'setThreshold':
            return k.setThreshold(x, BigInt(op.threshold), pubkeys, signatures);
          case 'setEmergencyPauser':
            return k.setEmergencyPauser(x, hex32ToBytes(op.newPauser, 'newPauser'), pubkeys, signatures);
          case 'rotateSigner': {
            if (!pop) throw new AppError('VALIDATION', 'rotateSigner needs the incoming signer’s proof-of-possession');
            return k.rotateSigner(x, hex32ToBytes(op.oldSignerCommitment, 'oldSignerCommitment'), pointFromJson(op.newSignerPubkey), toSchnorr(pop.signature), pubkeys, signatures);
          }
        }
      },
      () => {
        if (op.type === 'mint') this.credit(op.to, BigInt(op.value));
        if (op.type === 'burn') {
          this.held -= BigInt(op.value);
          this.credit(ZERO_COIN_PK, BigInt(op.value)); // the circuit sends burnt tokens to the all-zero address
        }
        if (op.type === 'contractWithdraw') {
          this.held -= BigInt(op.value);
          this.credit(op.to, BigInt(op.value));
        }
      }
    );
  }
}

const toSchnorr = (s: ApprovalSlotInput['signature']) => ({
  announcement: pointFromJson(s.announcement),
  response: BigInt(s.response)
});

/** Pads to the contract's 3 slots; unused slots are the zero point (skipped on-chain). */
export function padApprovals(approvals: ApprovalFile[]) {
  if (approvals.length < 1 || approvals.length > 3) throw new AppError('VALIDATION', 'Provide 1–3 approvals');
  const pubkeys = approvals.map((a) => pointFromJson(a.publicKey));
  const signatures = approvals.map((a) => toSchnorr(a.signature));
  while (pubkeys.length < 3) {
    pubkeys.push(IDENTITY_POINT);
    signatures.push({ announcement: IDENTITY_POINT, response: 0n });
  }
  return { pubkeys, signatures };
}
