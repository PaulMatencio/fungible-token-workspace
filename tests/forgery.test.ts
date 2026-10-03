import { createCircuitContext, createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import { describe, expect, it } from 'vitest';
import { Contract, signerTools as T } from '@/infrastructure/contract/module';
import { derivePublicKey, randomBytes, randomScalar } from '@/infrastructure/crypto/signing';

const P = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
const TWO_248 = 1n << 248n;
const pow = (b: bigint, e: bigint, m: bigint) => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; };
const inv = (a: bigint) => pow(a, P - 2n, P);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Builds a 2-of-3 contract whose prover-side `getSchnorrReduction` witness is `reduce`; returns a mint-with-random-signatures call. */
async function setup(reduce: (h: bigint) => [bigint, bigint]) {
  const pks = [randomScalar(), randomScalar(), randomScalar()].map((s) => derivePublicKey(s)); // secret keys discarded
  const salt = randomBytes(32);
  const comms = pks.map((p) => T.calculateSignerCommitment(p, salt));
  const witnesses = {
    localSecretKey: (ctx: { privateState: unknown }) => [ctx.privateState, new Uint8Array(32)],
    getSchnorrReduction: (ctx: { privateState: unknown }, h: bigint) => [ctx.privateState, reduce(h)]
  };
  const contract = new Contract<undefined>(witnesses as never);
  const init = await contract.initialState(createConstructorContext(undefined, '00'.repeat(32)), salt, randomBytes(32), randomBytes(32), 'T', 'T', 6n, 0n, comms, 2n);
  const ctx = createCircuitContext<undefined>(hex(randomBytes(32)), '00'.repeat(32), init.currentContractState, init.currentPrivateState);
  const forge = () => { const r = randomScalar(); return { announcement: derivePublicKey(r), response: r }; };
  const identity = { x: 0n, y: 1n };
  return () =>
    contract.impureCircuits.mint(ctx, new Uint8Array(32).fill(7), 1_000_000_000n, [pks[0], pks[1], identity] as never, [forge(), forge(), { announcement: identity, response: 0n }] as never);
}

describe('Schnorr challenge reduction soundness', () => {
  it('control: random signatures are rejected when the witness reduces honestly', async () => {
    const call = await setup((h) => [h / TWO_248, h % TWO_248]);
    expect(call).toThrow(/invalid signature/);
  });

  // FIXED (2026-10-03): the circuit now bounds q (Uint<8>, q <= 115). Before the fix, q was an unconstrained Field, so a
  // prover could choose challenge c = 0 and q = cFull / 2^248 (mod p) and forge approvals from PUBLIC keys alone.
  it('a prover who only knows the public keys cannot pass the threshold', async () => {
    // Malicious prover: challenge c = 0, announcement r·G, response r — no secret key involved.
    const call = await setup((h) => [(h * inv(TWO_248)) % P, 0n]);
    expect(call).toThrow(/type error|invalid challenge reduction/); // q no longer fits Uint<8>
  });

  it('an in-range quotient with a forged challenge fails the decomposition check', async () => {
    const call = await setup((h) => [h / TWO_248, 0n]); // q honest, c forced to 0
    expect(call).toThrow(/invalid challenge reduction/);
  });
});
