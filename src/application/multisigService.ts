import { AppError } from '@/domain/errors';
import { bytesToHex } from '@/domain/hex';
import type { ApprovalFile, MultisigOp, SigningRequest } from '@/domain/multisig';
import { parseApprovalFile } from '@/domain/multisig';
import type { TokenState, TxReceipt } from '@/domain/token';
import { friendlyMessage } from '@/domain/errors';
import type { SignerCrypto, TokenGateway, TxLogPort } from './ports';
import { parsePubkey, requireAccount, requireAmount, requireWalletAddress } from './validation';
import { runTracked } from './actionRun';

/**
 * v3 pads unused approval slots with the curve's identity point (0,1), which is a valid subgroup point, so the
 * contract's own threshold applies. (v2.6 padded with (0,0), which the real prover rejected, forcing all 3.)
 */
export const REAL_PROVER_APPROVALS = 2; // v3 pads unused slots with the identity point, so the contract threshold applies

export type OpInput =
  | { type: 'mint'; to: string; amount: string }
  | { type: 'burn'; amount: string }
  | { type: 'contractWithdraw'; to: string; amount: string }
  | { type: 'setEmergencyPauser'; newPauser: string }
  | { type: 'rotateSigner'; oldSignerCommitment: string; newSignerPubkey: string };

/**
 * Coordinator side of the OpenZeppelin-style multisig flow:
 *   1. build a signing request (bound to contract address + current nonce),
 *   2. cosigners sign it OFFLINE with signer-tools and return approval files,
 *   3. verify each approval independently, then submit.
 * No secret ever passes through the app.
 */
export class MultisigService {
  constructor(
    private readonly gateway: TokenGateway,
    private readonly crypto: SignerCrypto,
    private readonly network: string,
    private readonly decimals: number,
    private readonly log?: TxLogPort
  ) {}

  buildRequest(state: TokenState, input: OpInput): SigningRequest {
    let op: MultisigOp;
    switch (input.type) {
      case 'mint':
        op = { type: 'mint', to: requireWalletAddress(input.to, 'Recipient wallet'), value: requireAmount(input.amount, this.decimals).toString() };
        break;
      case 'burn':
        op = { type: 'burn', value: requireAmount(input.amount, this.decimals).toString() };
        if (BigInt(op.value) > state.contractBalance) throw new AppError('VALIDATION', 'The contract holds fewer tokens than that (burn only destroys contract-held tokens — deposit first)');
        break;
      case 'contractWithdraw':
        op = { type: 'contractWithdraw', to: requireWalletAddress(input.to, 'Recipient wallet'), value: requireAmount(input.amount, this.decimals).toString() };
        if (BigInt(op.value) > state.contractBalance) throw new AppError('VALIDATION', 'The contract holds fewer tokens than that');
        break;
      case 'setEmergencyPauser':
        op = { type: 'setEmergencyPauser', newPauser: requireAccount(input.newPauser, 'New pauser (manager token account)') };
        break;
      case 'rotateSigner': {
        const old = requireAccount(input.oldSignerCommitment, 'Old signer commitment');
        if (!state.signerCommitments.includes(old)) throw new AppError('VALIDATION', 'Old signer commitment is not registered');
        op = { type: 'rotateSigner', oldSignerCommitment: old, newSignerPubkey: parsePubkey(input.newSignerPubkey) };
        break;
      }
    }
    const req: SigningRequest = {
      version: 1,
      network: this.network,
      contractAddress: state.contractAddress,
      contractSalt: state.contractSalt,
      nonce: state.multisigNonce.toString(),
      op
    };
    this.crypto.computeDigest(req); // fail early on malformed input
    return req;
  }

  digestHex(req: SigningRequest): string {
    return bytesToHex(this.crypto.computeDigest(req));
  }

  /** Parses + verifies one uploaded approval; returns the file or throws with a reason. */
  acceptApproval(req: SigningRequest, state: TokenState, text: string, pop = false): ApprovalFile {
    const f = parseApprovalFile(text);
    if (pop !== (f.kind === 'pop')) throw new AppError('VALIDATION', pop ? 'Expected a proof-of-possession file' : 'Expected a regular approval file');
    const v = this.crypto.verifyApproval(req, f);
    if (!v.ok) throw new AppError('VALIDATION', v.reason);
    const commitment = this.crypto.commitmentFor(f.publicKey, state.contractSalt);
    if (!pop && !state.signerCommitments.includes(commitment)) {
      throw new AppError('VALIDATION', 'Signer is not registered on this contract');
    }
    return f;
  }

  /** Approvals needed to actually execute: the contract threshold, or all 3 slots on-chain (see REAL_PROVER_APPROVALS). */
  requiredApprovals(state: TokenState): number {
    return state.multisigThreshold;
  }

  async submit(req: SigningRequest, approvals: ApprovalFile[], pop?: ApprovalFile): Promise<TxReceipt> {
    const at = Date.now();
    const circuit = req.op.type;
    const base = { contractAddress: req.contractAddress, circuit, mode: this.gateway.mode, at };
    try {
      const r = await this.run(req, approvals, pop);
      await this.log?.add({ ...base, id: `${r.txHash}:${circuit}`, txHash: r.txHash, txId: r.txId, blockHeight: r.blockHeight, status: 'finalized' });
      return r;
    } catch (e) {
      await this.log?.add({ ...base, id: `fail:${at}:${circuit}`, txHash: '', txId: '', status: 'failed', error: friendlyMessage(e) });
      throw e;
    }
  }

  private async run(req: SigningRequest, approvals: ApprovalFile[], pop?: ApprovalFile): Promise<TxReceipt> {
    return runTracked({ mode: this.gateway.mode, title: req.op.type, multisig: true }, async (verified) => {
      const distinct = new Set(approvals.map((a) => `${a.publicKey.x}:${a.publicKey.y}`));
      if (distinct.size !== approvals.length) throw new AppError('VALIDATION', 'Duplicate signer among approvals');
      const state = await this.gateway.getState();
      if (state.multisigNonce.toString() !== req.nonce) {
        throw new AppError('VALIDATION', 'Nonce changed since this request was created — rebuild it and collect new signatures');
      }
      const need = this.requiredApprovals(state);
      if (approvals.length < need) {
        throw new AppError(
          'VALIDATION',
          `Need ${need} approvals, have ${approvals.length}`
        );
      }
      verified();
      return this.gateway.executeMultisig(req.op, approvals, pop);
    });
  }
}
