import { describe, expect, it } from 'vitest';
import { createCircuitContext, createConstructorContext, CompactTypeBytes, CompactTypeVector, persistentHash, rawTokenType, type CircuitContext } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '@contract/managed/fungible-token-native-v3/contract/index.js';
import { signerTools as T } from '@/infrastructure/contract/module';
import { IDENTITY_POINT, derivePublicKey, signDigest, signerCommitment, randomScalar } from '@/infrastructure/crypto/signing';
import { pad32 } from '@/infrastructure/crypto/identity';
import { bytesToHex, hexToBytes } from '@/domain/hex';

/**
 * Runs the compiled FungibleToken v3 (native unshielded token) circuits through the real Compact runtime.
 * The runtime does not apply token effects to a ledger, so this covers governance, supply accounting, access
 * control and argument validation — not the on-chain UTXO movement itself (needs preprod).
 */
const z = (n: number) => new Uint8Array(32).fill(n);
const salt = z(9);
const ADDR = 'ab'.repeat(32);
const addrBytes = hexToBytes(ADDR);

function setup(threshold = 2n, maxSupply = 0n, heldBalance = 0n) {
  const signers = [0, 1, 2].map(() => {
    const sk = randomScalar();
    return { sk, pk: derivePublicKey(sk) };
  });
  const commitments = signers.map((s) => hexToBytes(signerCommitment(s.pk, bytesToHex(salt))));
  let secret: Uint8Array = z(1);
  const contract = new Contract<undefined>({
    localSecretKey: (c) => [c.privateState, secret],
    getSchnorrReduction: (c, h) => [c.privateState, [h / (1n << 248n), h % (1n << 248n)]]
  });
  const account = (sk: Uint8Array) => persistentHash(new CompactTypeVector(3, new CompactTypeBytes(32)), [pad32('fungible-token:auth'), salt, sk]);
  const owner = account(z(1));
  const init = contract.initialState(createConstructorContext(undefined, '00'.repeat(32)), salt, owner, z(0xaa), 'Native', 'NAT', 6n, maxSupply, commitments, threshold);
  // Give the contract a held balance of the token (the runtime does not apply token effects to a ledger itself).
  if (heldBalance > 0n) {
    const color = rawTokenType(pad32('fungible-token:native'), ADDR);
    init.currentContractState.balance = new Map([[{ tag: 'unshielded' as const, raw: color }, heldBalance]]);
  }
  let ctx: CircuitContext<undefined> = createCircuitContext<undefined>(ADDR, '00'.repeat(32), init.currentContractState, init.currentPrivateState);
  const L = () => ledger(ctx.currentQueryContext.state);

  const approvals = (digest: Uint8Array, n: number) => {
    const pubkeys: unknown[] = [];
    const sigs: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      if (i < n) {
        pubkeys.push(signers[i].pk);
        sigs.push(signDigest(signers[i].sk, signers[i].pk, digest));
      } else {
        pubkeys.push(IDENTITY_POINT);
        sigs.push({ announcement: IDENTITY_POINT, response: 0n });
      }
    }
    return [pubkeys, sigs] as const;
  };
  const call = (name: string, ...args: unknown[]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (contract.impureCircuits as any)[name](ctx, ...args);
    ctx = r.context;
    return r.result as boolean;
  };
  return {
    call, L, approvals, owner,
    useSecret: (s: Uint8Array) => { secret = s; },
    nonce: () => L()._multisigNonce
  };
}

describe('FungibleToken v3 (native) — contract-held balance paths', () => {
  it('contractWithdraw and burn succeed with matching digests (same hashes the signer-tool uses)', () => {
    const t = setup(2n, 0n, 1000n);
    const wallet = z(0x55);
    // mint first so supply >= burn amount
    let [pks, sigs] = t.approvals(T.mintDigest(addrBytes, t.nonce(), wallet, 400n), 2);
    expect(t.call('mint', wallet, 400n, pks, sigs)).toBe(true);
    [pks, sigs] = t.approvals(T.withdrawDigest(addrBytes, t.nonce(), wallet, 300n), 2);
    expect(t.call('contractWithdraw', wallet, 300n, pks, sigs)).toBe(true);
    [pks, sigs] = t.approvals(T.burnDigestV3(addrBytes, t.nonce(), 100n), 2);
    expect(t.call('burn', 100n, pks, sigs)).toBe(true);
    expect(t.L()._totalSupply).toBe(300n); // 400 minted - 100 burned
    expect(t.nonce()).toBe(3n);
    // a signature over the wrong operation/digest is rejected
    [pks, sigs] = t.approvals(T.burnDigestV3(addrBytes, t.nonce(), 100n), 2);
    expect(() => t.call('contractWithdraw', wallet, 100n, pks, sigs)).toThrow(/invalid signature/);
  });

  it('refuses withdrawals above the held balance and emergencyWithdraw pays only while paused', () => {
    const t = setup(2n, 0n, 50n);
    const wallet = z(0x55);
    const [pks, sigs] = t.approvals(T.withdrawDigest(addrBytes, t.nonce(), wallet, 51n), 2);
    expect(() => t.call('contractWithdraw', wallet, 51n, pks, sigs)).toThrow(/holds too little/);
    expect(() => t.call('emergencyWithdraw', t.owner, 10n)).toThrow(/not paused/);
    expect(t.call('pause', t.owner)).toBe(true);
    expect(t.call('emergencyWithdraw', t.owner, 10n)).toBe(true);
    expect(() => t.call('emergencyWithdraw', t.owner, 51n)).toThrow(/holds too little/);
  });
});

describe('FungibleToken v3 (native) — compiled circuits', () => {
  it('mints with 2 approvals and an identity-padded slot, and tracks supply', () => {
    const t = setup();
    const to = z(0x33);
    const [pks, sigs] = t.approvals(T.mintDigest(addrBytes, t.nonce(), to, 5000n), 2); // slot 3 = identity point
    expect(t.call('mint', to, 5000n, pks, sigs)).toBe(true);
    expect(t.L()._totalSupply).toBe(5000n);
    expect(t.nonce()).toBe(1n);
  });

  it('rejects below-threshold approvals, wrong digests, replays and a zero receiver', () => {
    const t = setup();
    const to = z(0x33);
    let [pks, sigs] = t.approvals(T.mintDigest(addrBytes, t.nonce(), to, 1n), 1);
    expect(() => t.call('mint', to, 1n, pks, sigs)).toThrow(/threshold not met/);
    [pks, sigs] = t.approvals(T.mintDigest(addrBytes, t.nonce(), to, 1n), 2);
    expect(() => t.call('mint', to, 2n, pks, sigs)).toThrow(/invalid signature/); // signed 1, submitted 2
    expect(() => t.call('mint', z(0), 1n, pks, sigs)).toThrow(/invalid receiver/);
    expect(t.call('mint', to, 1n, pks, sigs)).toBe(true);
    expect(() => t.call('mint', to, 1n, pks, sigs)).toThrow(/invalid signature/); // nonce advanced: old signatures are dead
  });

  it('enforces the max supply', () => {
    const t = setup(2n, 100n);
    const to = z(0x33);
    let [pks, sigs] = t.approvals(T.mintDigest(addrBytes, t.nonce(), to, 100n), 2);
    expect(t.call('mint', to, 100n, pks, sigs)).toBe(true);
    [pks, sigs] = t.approvals(T.mintDigest(addrBytes, t.nonce(), to, 1n), 2);
    expect(() => t.call('mint', to, 1n, pks, sigs)).toThrow(/max supply exceeded/);
  });

  it('threshold 1 and 3 both work', () => {
    for (const th of [1n, 3n]) {
      const t = setup(th);
      const to = z(0x44);
      const [pks, sigs] = t.approvals(T.mintDigest(addrBytes, t.nonce(), to, 7n), Number(th));
      expect(t.call('mint', to, 7n, pks, sigs)).toBe(true);
    }
  });

  it('burn and contractWithdraw are multisig-gated and bounded by the contract-held balance', () => {
    const t = setup();
    // The contract holds nothing yet: both must refuse before checking signatures.
    let [pks, sigs] = t.approvals(T.burnDigestV3(addrBytes, t.nonce(), 10n), 2);
    expect(() => t.call('burn', 10n, pks, sigs)).toThrow(/burn exceeds supply|holds too little/);
    [pks, sigs] = t.approvals(T.withdrawDigest(addrBytes, t.nonce(), z(0x55), 10n), 2);
    expect(() => t.call('contractWithdraw', z(0x55), 10n, pks, sigs)).toThrow(/holds too little/);
    expect(() => t.call('contractWithdraw', z(0), 10n, pks, sigs)).toThrow(/invalid receiver/);
  });

  it('deposit refuses zero; pause gates mint/deposit; only owner/pauser can pause', () => {
    const t = setup();
    expect(() => t.call('deposit', 0n)).toThrow(/nothing to deposit/);
    expect(t.call('deposit', 5n)).toBe(true);
    t.useSecret(z(7)); // not the owner
    expect(() => t.call('pause', t.owner)).toThrow(/authorization failed/);
    t.useSecret(z(1));
    expect(t.call('pause', t.owner)).toBe(true);
    expect(t.L()._paused).toBe(true);
    expect(() => t.call('deposit', 5n)).toThrow(/paused/);
    const to = z(0x33);
    const [pks, sigs] = t.approvals(T.mintDigest(addrBytes, t.nonce(), to, 1n), 2);
    expect(() => t.call('mint', to, 1n, pks, sigs)).toThrow(/paused/);
    // emergencyWithdraw is only available while paused, to the owner, and bounded by the held balance
    expect(() => t.call('emergencyWithdraw', t.owner, 1n)).toThrow(/holds too little/);
    expect(t.call('unpause', t.owner)).toBe(true);
    expect(() => t.call('emergencyWithdraw', t.owner, 1n)).toThrow(/not paused/);
  });

  it('setEmergencyPauser rotates the pauser by multisig', () => {
    const t = setup();
    const np = z(0x66);
    const [pks, sigs] = t.approvals(T.setEmergencyPauserDigest(addrBytes, t.nonce(), np), 2);
    expect(t.call('setEmergencyPauser', np, pks, sigs)).toBe(true);
    expect(bytesToHex(t.L()._emergencyPauser)).toBe(bytesToHex(np));
  });

  it('setThreshold changes the approvals required, by multisig', () => {
    const t = setup(); // 2-of-3
    const to = z(0x77);
    const [p2, s2] = t.approvals(T.setThresholdDigest(addrBytes, t.nonce(), 3n), 2);
    expect(t.call('setThreshold', 3n, p2, s2)).toBe(true);
    expect(t.L()._multisigThreshold).toBe(3n);
    // 2 approvals no longer enough for a mint; 3 are
    const [pk2, sg2] = t.approvals(T.mintDigest(addrBytes, t.nonce(), to, 5n), 2);
    expect(() => t.call('mint', to, 5n, pk2, sg2)).toThrow(/threshold not met/);
    const [pk3, sg3] = t.approvals(T.mintDigest(addrBytes, t.nonce(), to, 5n), 3);
    expect(t.call('mint', to, 5n, pk3, sg3)).toBe(true);
    // all 3 can lower it to 1, after which a single approval suffices
    const [p3, s3] = t.approvals(T.setThresholdDigest(addrBytes, t.nonce(), 1n), 3);
    expect(t.call('setThreshold', 1n, p3, s3)).toBe(true);
    const [pk1, sg1] = t.approvals(T.mintDigest(addrBytes, t.nonce(), to, 1n), 1);
    expect(t.call('mint', to, 1n, pk1, sg1)).toBe(true);
  });

  it('setThreshold rejects out-of-range or unchanged values and forged approvals', () => {
    const t = setup();
    for (const bad of [0n, 4n]) {
      const [pks, sigs] = t.approvals(T.setThresholdDigest(addrBytes, t.nonce(), bad), 2);
      expect(() => t.call('setThreshold', bad, pks, sigs)).toThrow(/invalid threshold/);
    }
    const [pks, sigs] = t.approvals(T.setThresholdDigest(addrBytes, t.nonce(), 2n), 2);
    expect(() => t.call('setThreshold', 2n, pks, sigs)).toThrow(/unchanged/);
    // an approval for a different value does not authorize this one
    const [pw, sw] = t.approvals(T.setThresholdDigest(addrBytes, t.nonce(), 1n), 2);
    expect(() => t.call('setThreshold', 3n, pw, sw)).toThrow(/invalid signature/);
  });
});
