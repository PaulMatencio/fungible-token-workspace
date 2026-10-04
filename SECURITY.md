# Security policy

## Status
This project targets the Midnight **preprod** test network. It has **not been independently audited**. Do not use it
with mainnet funds.

## Reporting a vulnerability
Please report suspected vulnerabilities **privately** through GitHub's *Security → Report a vulnerability* (private
advisory) on this repository, not in a public issue. Include the affected file or circuit, a description, and steps or a
test that reproduces it. You can expect an acknowledgement within a few days.

## History
* **2026-10-03 — Schnorr challenge reduction (fixed).** The witness quotient was an unbounded `Field`, which let a
  prover choose the challenge and forge multisig approvals from public keys alone. Fixed by typing it `Uint<8>` and
  asserting `q <= 115`. Contracts deployed before the fix are forgeable; the app refuses them (`CONTRACT_VERSION`).
  `tests/forgery.test.ts` is the regression test. The legacy v2.6 contract has the same flaw (see its repository).

## Trust assumptions (by design)
* **Maintenance authority key** — created at deploy, kept in the browser's local storage (`ft:sk:<contract>`). Whoever
  holds it can replace circuit verifier keys and therefore change what the contract does. Back it up (encrypted backup in
  the Identity card) and treat it like an admin key. There is no handover circuit.
* **Owner key** — the owner can `pause` and, while paused, `emergencyWithdraw` contract-held tokens to the fixed
  treasury wallet without multisig approval. The treasury is fixed at deploy.
* **Local storage** — the identity and authority keys are stored unencrypted in the browser; use the encrypted backup and
  a dedicated browser profile.
* **Proof server** — proofs must come from a prover you run yourself (`docker compose up -d`, loopback only). The app
  never uses a wallet-hosted prover, because proof requests include private witnesses.
* **Tooling API** (`/api/tooling`) spawns local processes. It is loopback and same-origin only and disabled in production
  unless `MIDNIGHT_TOOLING=1`; never enable that on a publicly reachable host.

## Content-Security-Policy
`next.config.mjs` sends a CSP: scripts from the app only (`'unsafe-inline'` remains for Next.js's inline bootstrap, and
`'wasm-unsafe-eval'` for the Midnight WASM runtime), `connect-src` limited to the app, the configured indexer/node, the
Midnight and 1AM hosts and the local proof server, `object-src 'none'`, `frame-ancestors 'none'`. If a wallet is
configured with an indexer on another host the browser console shows a `connect-src` violation: add the host with
`CSP_CONNECT_EXTRA="https://host wss://host"`, or set `CSP_REPORT_ONLY=1` to log violations without blocking.

## Never commit
Key files, approval/request files, `.env*`, `*.prover` proving keys (large, regenerable) and wallet seed phrases.
