#!/usr/bin/env node
/**
 * Read-only: asks the public preprod node for a contract's state and prints which circuits are registered.
 *   node scripts/check-contract.mjs <64-hex contract address>
 * Uses only the node's `midnight_contractState` RPC (no wallet, no secrets, nothing is sent on-chain).
 */
import { readFileSync, readdirSync } from 'node:fs';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { rawTokenType, ContractState as RtContractState } from '@midnight-ntwrk/compact-runtime';

const cfg = JSON.parse(readFileSync('midnight.config.json', 'utf8'));
const address = (process.argv[2] ?? '').replace(/^0x/, '').toLowerCase();
if (!/^[0-9a-f]{64}$/.test(address)) {
  console.error('usage: node scripts/check-contract.mjs <64-hex contract address>');
  process.exit(2);
}

const res = await fetch(cfg.nodeRpc, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'midnight_contractState', params: [address] })
});
const j = await res.json();
if (j.error || !j.result) {
  console.log(`NOT FOUND on ${cfg.networkId} (${cfg.nodeRpc}): ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
  process.exit(1);
}

const state = ledger.ContractState.deserialize(Buffer.from(j.result.replace(/^0x/, ''), 'hex'));
const registered = new Set(state.operations().map((o) => (typeof o === 'string' ? o : new TextDecoder().decode(o))));
const dir = cfg.contract?.managedDir ?? 'contract/managed/fungible-token-native-v3';
const expected = readdirSync(`${dir}/keys`).filter((f) => f.endsWith('.verifier')).map((f) => f.replace('.verifier', '')).sort();
const missing = expected.filter((c) => !registered.has(c));

// Tokens held by the contract itself (v3 native token): ContractState.balance, keyed by the token color.
const pad = (t) => { const o = new Uint8Array(32); o.set(new TextEncoder().encode(t)); return o; };
const colorRaw = rawTokenType(pad('fungible-token:native'), address);
const colorHex = typeof colorRaw === 'string' ? colorRaw.toLowerCase() : Buffer.from(colorRaw).toString('hex');
let held = 0n;
const bal = RtContractState.deserialize(Buffer.from(j.result.replace(/^0x/, ''), 'hex')).balance;
for (const [k, v] of bal) {
  const raw = typeof k === 'object' && k !== null ? k.raw : k;
  const hex = typeof raw === 'string' ? raw.toLowerCase() : Buffer.from(raw ?? []).toString('hex');
  if (hex === colorHex) held = v;
}

console.log(`Contract ${address}`);
console.log(`Network  : ${cfg.networkId} via ${cfg.nodeRpc}`);
console.log(`State    : found (${(j.result.length - 2) / 2} bytes)`);
console.log(`Registered (${registered.size}/${expected.length}): ${[...registered].sort().join(', ') || '—'}`);
// Authoritative figure: the indexer's unshielded balances for the contract (UTXO view).
let indexed = null;
try {
  const q = `query($a: HexEncoded!){ contractAction(address:$a){ unshieldedBalances{ tokenType amount } } }`;
  const r = await fetch(cfg.indexer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q, variables: { a: address } }) });
  const ij = await r.json();
  const list = ij?.data?.contractAction?.unshieldedBalances;
  if (list) indexed = BigInt(list.find((b) => b.tokenType.toLowerCase() === colorHex)?.amount ?? 0);
  else console.log(`Indexer  : ${JSON.stringify(ij.errors ?? ij).slice(0, 200)}`);
} catch (e) { console.log(`Indexer  : unreachable (${e.message})`); }
console.log(`Held by the contract (indexer UTXO balance): ${indexed ?? 'n/a'} base units  [color ${colorHex.slice(0, 12)}…]`);
console.log(`Held by the contract (node ContractState)  : ${held} base units`);
console.log(missing.length ? `Missing    (${missing.length}): ${missing.join(', ')}` : 'All circuits registered.');
