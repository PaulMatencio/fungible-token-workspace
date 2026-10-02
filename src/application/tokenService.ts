import { AppError, friendlyMessage } from '@/domain/errors';
import type { CircuitName, TxReceipt } from '@/domain/token';
import type { TokenGateway, TxLogEntry, TxLogPort } from './ports';
import { requireAmount, requireWalletAddress } from './validation';
import { runTracked } from './actionRun';
import type { StepDef } from './deployProgress';

type Logger = Pick<TxLogPort, 'add'>;

/** Native wallet→wallet transfer: no circuit/proof — the wallet builds, signs and submits. */
const NATIVE_TRANSFER_STEPS: StepDef[] = [
  { id: 'validate', labelKey: 'action.step.validate' },
  { id: 'balance', labelKey: 'action.step.walletBuild', hintKey: 'deploy.step.balance.hint' },
  { id: 'submit', labelKey: 'action.step.submit', hintKey: 'deploy.step.submit.hint' },
  { id: 'confirm', labelKey: 'action.step.confirm', hintKey: 'deploy.step.confirm.hint' }
];

/**
 * Use-cases for the connected FungibleToken v3 (native unshielded token). Validates input, delegates to the gateway,
 * and persists every attempt (success or failure) to the log.
 */
export class TokenService {
  constructor(
    private readonly gateway: TokenGateway,
    private readonly log: Logger,
    /** The manager's token account (hash-derived), used only for pause / unpause / emergencyWithdraw. */
    private readonly account: string,
    private readonly decimals: number,
    /** The acting wallet's address as 64-hex UserAddress bytes (sender of deposits and transfers). */
    private readonly wallet: string
  ) {}

  private async track(circuit: CircuitName | 'transfer', fn: () => Promise<TxReceipt>): Promise<TxReceipt> {
    const base: Pick<TxLogEntry, 'contractAddress' | 'circuit' | 'mode' | 'at'> = {
      contractAddress: this.gateway.contractAddress,
      circuit,
      mode: this.gateway.mode,
      at: Date.now()
    };
    try {
      // Validation already happened in the caller, so the first step is complete as soon as we start.
      const native = circuit === 'transfer' && this.gateway.mode === 'wallet';
      const r = await runTracked(
        { mode: this.gateway.mode, title: circuit, steps: native ? NATIVE_TRANSFER_STEPS : undefined },
        async (firstDone) => {
          firstDone(native ? 'balance' : 'build');
          return fn();
        }
      );
      await this.log.add({ ...base, id: `${r.txHash}:${circuit}`, txHash: r.txHash, txId: r.txId, blockHeight: r.blockHeight, status: 'finalized' });
      return r;
    } catch (e) {
      await this.log.add({ ...base, id: `fail:${base.at}:${circuit}`, txHash: '', txId: '', status: 'failed', error: friendlyMessage(e) });
      throw e instanceof AppError ? e : new AppError('CONTRACT_REJECTED', friendlyMessage(e), { cause: e });
    }
  }

  /** Wallet → wallet transfer of the native token (done by the wallet, not the contract). */
  transfer(to: string, amount: string) {
    const [t, v] = [requireWalletAddress(to, 'Recipient'), requireAmount(amount, this.decimals)];
    return this.track('transfer', () => this.gateway.transferNative(this.wallet, t, v));
  }
  /** Wallet → contract-held balance. */
  deposit(amount: string) {
    const v = requireAmount(amount, this.decimals);
    return this.track('deposit', () => this.gateway.deposit(this.wallet, v));
  }
  pause() {
    return this.track('pause', () => this.gateway.pause(this.account));
  }
  unpause() {
    return this.track('unpause', () => this.gateway.unpause(this.account));
  }
  emergencyWithdraw(amount: string) {
    const v = requireAmount(amount, this.decimals);
    return this.track('emergencyWithdraw', () => this.gateway.emergencyWithdraw(this.account, v));
  }

  // Read-only
  /** Balance of this app user's own wallet. */
  myBalance() {
    return this.gateway.walletBalance(this.wallet);
  }
  /** Balance of another wallet (Test Mode only; the real wallet API exposes only the connected wallet). */
  balanceOf(address: string) {
    return this.gateway.walletBalance(requireWalletAddress(address, 'Wallet'));
  }
}
