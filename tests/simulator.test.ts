import { describe, expect, it } from 'vitest';
import { SimulatorGateway } from '@/infrastructure/gateway/simulatorGateway';
import { deriveAccount, generateSecretKey } from '@/infrastructure/crypto/identity';
import { derivePublicKey, makeApprovalFile, randomScalar, selfTest, signerCommitment, verifyApprovalFile } from '@/infrastructure/crypto/signing';
import type { SigningRequest } from '@/domain/multisig';

const salt = 'ab'.repeat(32);
const wallet = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const [ALICE, BOB, TREASURY] = [wallet(0x11), wallet(0x22), wallet(0xaa)];

async function setup(threshold: 1 | 2 | 3 = 2) {
  const keys = new Map<string, Uint8Array>();
  const owner = (() => {
    const sk = generateSecretKey();
    const a = deriveAccount(sk, salt);
    keys.set(a, sk);
    return a;
  })();
  const signers = [0, 1, 2].map(() => {
    const sk = randomScalar();
    const pk = derivePublicKey(sk);
    return { sk, pk, commitment: signerCommitment(pk, salt) };
  });
  const gw = await SimulatorGateway.deploy(
    {
      name: 'Native', symbol: 'NAT', decimals: 6, maxSupply: 0n, salt, threshold, treasury: TREASURY,
      signerCommitments: [signers[0].commitment, signers[1].commitment, signers[2].commitment]
    },
    owner,
    (a) => keys.get(a)!
  );
  const sign = async (op: SigningRequest['op'], who: number[]) => {
    const st = await gw.getState();
    const req: SigningRequest = { version: 1, contractAddress: gw.contractAddress, contractSalt: salt, nonce: st.multisigNonce.toString(), op };
    return { req, files: who.map((i) => makeApprovalFile(req, signers[i].sk, signers[i].pk)) };
  };
  const exec = async (op: SigningRequest['op'], who = [0, 1]) => {
    const { req, files } = await sign(op, who);
    return gw.executeMultisig(req.op, files);
  };
  return { gw, owner, signers, sign, exec };
}

describe('simulator + signing (v3 native token)', () => {
  it('self-test passes', () => selfTest());

  it('mints to a wallet with only 2 approvals (identity-padded slot)', async () => {
    const { gw, exec } = await setup(2);
    await exec({ type: 'mint', to: ALICE, value: '1000' });
    expect(await gw.walletBalance(ALICE)).toBe(1000n);
    const st = await gw.getState();
    expect(st.totalSupply).toBe(1000n);
    expect(st.multisigNonce).toBe(1n);
  });

  it('rejects below-threshold approvals and tampered digests', async () => {
    const { gw, sign, exec } = await setup(2);
    await expect(exec({ type: 'mint', to: ALICE, value: '5' }, [0])).rejects.toThrow(/threshold not met/);
    const { req, files } = await sign({ type: 'mint', to: ALICE, value: '1' }, [0]);
    expect(verifyApprovalFile({ ...req, op: { type: 'mint', to: ALICE, value: '2' } }, files[0]).ok).toBe(false);
    expect(await gw.walletBalance(ALICE)).toBe(0n);
  });

  it('native wallet→wallet transfer is plain accounting (no circuit), and respects balances', async () => {
    const { gw, exec } = await setup();
    await exec({ type: 'mint', to: ALICE, value: '1000' });
    await gw.transferNative(ALICE, BOB, 250n);
    expect(await gw.walletBalance(ALICE)).toBe(750n);
    expect(await gw.walletBalance(BOB)).toBe(250n);
    await expect(gw.transferNative(BOB, ALICE, 999n)).rejects.toThrow(/Insufficient/);
  });

  it('deposit → burn / contractWithdraw move contract-held tokens only', async () => {
    const { gw, exec } = await setup();
    await exec({ type: 'mint', to: ALICE, value: '1000' });
    await gw.deposit(ALICE, 600n);
    let st = await gw.getState();
    expect(st.contractBalance).toBe(600n);
    expect(await gw.walletBalance(ALICE)).toBe(400n);
    await exec({ type: 'contractWithdraw', to: BOB, value: '100' });
    await exec({ type: 'burn', value: '200' });
    st = await gw.getState();
    expect(st.contractBalance).toBe(300n);
    expect(st.totalSupply).toBe(800n); // 1000 minted − 200 burned
    expect(await gw.walletBalance(BOB)).toBe(100n);
    await expect(exec({ type: 'burn', value: '301' })).rejects.toThrow(/holds too little/);
  });

  it('pause blocks deposit and mint but not native transfers; emergencyWithdraw pays the treasury while paused', async () => {
    const { gw, owner, exec } = await setup();
    await exec({ type: 'mint', to: ALICE, value: '1000' });
    await gw.deposit(ALICE, 500n);
    await gw.pause(owner);
    await expect(gw.deposit(ALICE, 1n)).rejects.toThrow(/paused/);
    await expect(exec({ type: 'mint', to: ALICE, value: '1' })).rejects.toThrow(/paused/);
    await gw.transferNative(ALICE, BOB, 10n); // the contract is not in this path
    await gw.emergencyWithdraw(owner, 120n);
    expect(await gw.walletBalance(TREASURY)).toBe(120n);
    expect((await gw.getState()).contractBalance).toBe(380n);
    await gw.unpause(owner);
    await expect(gw.emergencyWithdraw(owner, 1n)).rejects.toThrow(/not paused/);
  });

  it('rejects a wrong manager secret (authenticate)', async () => {
    const { gw } = await setup();
    const sk = generateSecretKey();
    const stranger = deriveAccount(sk, salt);
    const gw2 = gw as unknown as { resolveSk: (a: string) => Uint8Array };
    void gw2;
    await expect(gw.pause(stranger)).rejects.toThrow();
  });

  it('rotates a signer with proof of possession', async () => {
    const { gw, signers, sign } = await setup(2);
    const sk = randomScalar();
    const pk = derivePublicKey(sk);
    const op = { type: 'rotateSigner' as const, oldSignerCommitment: signers[2].commitment, newSignerPubkey: { x: String((pk as any).x), y: String((pk as any).y) } };
    const { req, files } = await sign(op, [0, 1]);
    const pop = makeApprovalFile(req, sk, pk, 'pop');
    expect(verifyApprovalFile(req, pop).ok).toBe(true);
    await gw.executeMultisig(op, files, pop);
    const st = await gw.getState();
    expect(st.signerCommitments).toContain(signerCommitment(pk, salt));
    expect(st.signerCommitments).not.toContain(signers[2].commitment);
  });
});

describe('simulator persistence', () => {
  it('restores identical state — including wallet and contract balances — by replaying a snapshot', async () => {
    const { gw, exec } = await setup(2);
    await exec({ type: 'mint', to: ALICE, value: '500' });
    await gw.transferNative(ALICE, BOB, 100n);
    await gw.deposit(BOB, 40n);
    const snap = JSON.parse(JSON.stringify(gw.snapshot()));
    const restored = await SimulatorGateway.restore(snap, (a) => (gw as any).resolveSk(a));
    expect(restored.contractAddress).toBe(gw.contractAddress);
    expect(await restored.walletBalance(ALICE)).toBe(400n);
    expect(await restored.walletBalance(BOB)).toBe(60n);
    const st = await restored.getState();
    expect(st.contractBalance).toBe(40n);
    expect(st.multisigNonce).toBe(1n);
  });
});
