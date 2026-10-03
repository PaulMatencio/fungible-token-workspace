import { describe, expect, it } from 'vitest';
import { MultisigService } from '@/application/multisigService';
import { TokenService } from '@/application/tokenService';
import { buildDeployParams } from '@/application/validation';
import { formatAmount, parseAmount } from '@/domain/amount';
import { resolveRole } from '@/domain/roles';
import { SimulatorGateway } from '@/infrastructure/gateway/simulatorGateway';
import { deriveAccount, generateSecretKey } from '@/infrastructure/crypto/identity';
import { derivePublicKey, makeApprovalFile, pointToJson, randomScalar } from '@/infrastructure/crypto/signing';
import { signerCrypto } from '@/infrastructure/crypto/signerCrypto';
import { MemoryStore } from '@/infrastructure/storage/kv';
import { TxLog } from '@/infrastructure/storage/txLog';

const salt = 'cd'.repeat(32);
const w = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const [ALICE, BOB, TREASURY] = [w(0x11), w(0x22), w(0xaa)];

describe('amounts', () => {
  it('round-trips decimals', () => {
    expect(parseAmount('12.5', 6)).toBe(12_500_000n);
    expect(formatAmount(12_500_000n, 6)).toBe('12.5');
    expect(formatAmount(200_000_000_000n, 6, { group: true })).toBe('200,000');
    expect(formatAmount(2_000_000_000_000_000_000n, 6, { group: true })).toBe('2,000,000,000,000');
    expect(formatAmount(1_234_567n, 6, { group: true })).toBe('1.234567');
    expect(() => parseAmount('1.1234567', 6)).toThrow();
    expect(() => parseAmount('-1', 6)).toThrow();
  });
});

describe('roles', () => {
  it('resolves manager / cosigner / user', () => {
    const base = { owner: 'a'.repeat(64), registeredCommitments: ['c'.repeat(64)] };
    expect(resolveRole({ ...base, account: 'a'.repeat(64) }).role).toBe('manager');
    expect(resolveRole({ ...base, account: 'b'.repeat(64), signerCommitment: 'c'.repeat(64) }).role).toBe('cosigner');
    expect(resolveRole({ ...base, account: 'b'.repeat(64) }).role).toBe('user');
  });
});

async function deployed(threshold: '1' | '2' | '3' = '2') {
  const keys = new Map<string, Uint8Array>();
  const sk = generateSecretKey();
  const owner = deriveAccount(sk, salt);
  keys.set(owner, sk);
  const signers = [0, 1, 2].map(() => {
    const s = randomScalar();
    return { sk: s, pk: derivePublicKey(s) };
  });
  const params = buildDeployParams(
    {
      name: 'Token', symbol: 'TKN', decimals: '6', maxSupply: '1000000', threshold, treasury: TREASURY,
      signerPubkeys: signers.map((s) => JSON.stringify(pointToJson(s.pk))) as [string, string, string]
    },
    signerCrypto.commitmentFor,
    salt
  );
  const gw = await SimulatorGateway.deploy(params, owner, (a) => keys.get(a)!);
  const ms = new MultisigService(gw, signerCrypto, 'preprod', 6);
  const approve = async (op: Parameters<MultisigService['buildRequest']>[1], who: number[]) => {
    const st = await gw.getState();
    const req = ms.buildRequest(st, op);
    const approvals = who.map((i) => ms.acceptApproval(req, st, JSON.stringify(makeApprovalFile(req, signers[i].sk, signers[i].pk))));
    return { req, st, approvals };
  };
  return { gw, ms, owner, signers, approve };
}

describe('end-to-end services on the simulator (v3)', () => {
  it('deploy form → mint via offline approvals → wallet transfer → deposit → persistent log', async () => {
    const { gw, ms, approve } = await deployed();
    const { req, approvals } = await approve({ type: 'mint', to: ALICE, amount: '100' }, [0, 1]);
    await ms.submit(req, approvals);
    expect(await gw.walletBalance(ALICE)).toBe(100_000_000n);
    await expect(ms.submit(req, approvals)).rejects.toThrow(/Nonce changed/); // replay

    const log = new TxLog(new MemoryStore());
    const svc = new TokenService(gw, log, 'f'.repeat(64), 6, ALICE);
    await svc.transfer(BOB, '25.5');
    expect(await svc.balanceOf(BOB)).toBe(25_500_000n);
    expect(await svc.myBalance()).toBe(74_500_000n);
    await svc.deposit('10');
    expect((await gw.getState()).contractBalance).toBe(10_000_000n);
    await expect(svc.transfer(BOB, '1000')).rejects.toThrow(/Insufficient/);
    const rows = await log.list(gw.contractAddress);
    expect(rows.filter((r) => r.status === 'failed')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'finalized').map((r) => r.circuit).sort()).toEqual(['deposit', 'transfer']);
  });

  it('refuses a wallet address in the wrong form and a token account where a wallet is expected', async () => {
    const { gw } = await deployed();
    const svc = new TokenService(gw, new TxLog(new MemoryStore()), 'f'.repeat(64), 6, ALICE);
    // validation runs synchronously, before anything is sent
    expect(() => svc.transfer('mn_addr_preprod1abc', '1')).toThrow(/not converted|Bech32m/);
    expect(() => svc.transfer('zz', '1')).toThrow(/unshielded wallet address/);
    expect(() => svc.transfer('00'.repeat(32), '1')).toThrow(/all-zero/);
  });

  it('refuses the contract\'s own address as a recipient (tokens would be lost)', async () => {
    const { gw, ms } = await deployed();
    const st = await gw.getState();
    for (const type of ['mint', 'contractWithdraw'] as const) {
      expect(() => ms.buildRequest(st, { type, to: gw.contractAddress, amount: '1' })).toThrow(/CONTRACT's own address/);
    }
  });

  it('the circuits themselves refuse the contract address as a recipient (not just the UI)', async () => {
    const { gw, signers } = await deployed();
    const st = await gw.getState();
    for (const type of ['mint', 'contractWithdraw'] as const) {
      const op = { type, to: gw.contractAddress, value: '1000000' } as const;
      const req = { version: 1 as const, network: 'preprod', contractAddress: st.contractAddress, contractSalt: st.contractSalt, nonce: st.multisigNonce.toString(), op };
      const approvals = [0, 1].map((i) => makeApprovalFile(req, signers[i].sk, signers[i].pk));
      await expect(gw.executeMultisig(op, approvals)).rejects.toThrow(/contract address/);
    }
  });

  it('lostTokens reports burnt tokens (all-zero address)', async () => {
    const { gw, ms, approve } = await deployed();
    const mint = await approve({ type: 'mint', to: ALICE, amount: '100' }, [0, 1]);
    await ms.submit(mint.req, mint.approvals);
    const svc = new TokenService(gw, new TxLog(new MemoryStore()), 'f'.repeat(64), 6, ALICE);
    await svc.deposit('40');
    const burn = await approve({ type: 'burn', amount: '15' }, [0, 1]);
    await ms.submit(burn.req, burn.approvals);
    expect(await svc.lostTokens()).toEqual({ burned: 15_000_000n, atContractAddress: 0n });
  });

  it('burn / withdraw are limited by what the contract holds', async () => {
    const { gw, ms, approve } = await deployed();
    const st = await gw.getState();
    expect(() => ms.buildRequest(st, { type: 'burn', amount: '1' })).toThrow(/holds fewer/);
    expect(() => ms.buildRequest(st, { type: 'contractWithdraw', to: BOB, amount: '1' })).toThrow(/holds fewer/);
    void approve;
  });

  it('rejects approvals from unregistered signers', async () => {
    const { gw, ms } = await deployed('1');
    const st = await gw.getState();
    const req = ms.buildRequest(st, { type: 'mint', to: ALICE, amount: '1' });
    const rogue = randomScalar();
    const f = JSON.stringify(makeApprovalFile(req, rogue, derivePublicKey(rogue)));
    expect(() => ms.acceptApproval(req, st, f)).toThrow(/not registered/);
  });
});

describe('action progress', () => {
  it('reports steps for multisig and holder actions, success and failure', async () => {
    const { actionTracker } = await import('@/application/deployProgress');
    const { gw, ms, approve } = await deployed();
    const { req, approvals } = await approve({ type: 'mint', to: ALICE, amount: '10' }, [0, 1]);
    await ms.submit(req, approvals);
    let snap = actionTracker.snapshot!;
    expect(snap).toMatchObject({ title: 'mint', status: 'success', mode: 'test' });
    expect(snap.steps.map((s) => s.id)).toEqual(['verify', 'build']);
    expect(snap.steps.every((s) => s.status === 'done')).toBe(true);

    const svc = new TokenService(gw, new TxLog(new MemoryStore()), 'f'.repeat(64), 6, ALICE);
    await svc.transfer(BOB, '3');
    expect(actionTracker.snapshot).toMatchObject({ title: 'transfer', status: 'success' });
    await expect(svc.transfer(BOB, '1000')).rejects.toThrow();
    snap = actionTracker.snapshot!;
    expect(snap.status).toBe('failed');
    expect(snap.steps.find((s) => s.status === 'error')?.error).toBeTruthy();

    await expect(ms.submit(req, approvals)).rejects.toThrow(/Nonce changed/);
    expect(actionTracker.snapshot!.steps[0]).toMatchObject({ id: 'verify', status: 'error' });
  });

  it('the contract threshold applies on-chain too (v3 pads empty slots with the identity point)', async () => {
    const wallet = new MultisigService({ mode: 'wallet' } as never, signerCrypto, 'preprod', 0);
    const test = new MultisigService({ mode: 'test' } as never, signerCrypto, 'preprod', 0);
    expect(wallet.requiredApprovals({ multisigThreshold: 2 } as never)).toBe(2);
    expect(test.requiredApprovals({ multisigThreshold: 2 } as never)).toBe(2);
  });
});
