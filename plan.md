# Plan — FungibleToken (native, v3) Midnight DApp

> Status: **v3 implemented and verified on preprod** (every circuit has run on-chain). This file replaces the original
> v2.6 brief. The v2.6 front end and contract live in their own repository (`fungible-token-workspace-v2.6`, legacy,
> has the Schnorr flaw fixed in v3). Design details: [design.md](design.md). Policy: [SECURITY.md](SECURITY.md).

## Primary goal
Maintain a **React 19 / Next.js 15 (App Router)** DApp in this directory that compiles, tests, deploys and operates
`contract/fungible_token_native_v3.compact` on **Midnight preprod**: a **native unshielded token** whose issuance and
treasury are governed by an **offline k-of-3 multisig**.

## Stack
* React 19, Next.js 15 (App Router), TypeScript, Tailwind (midnight theme), vitest
* Compact compiler **0.31.1** ↔ compact-runtime 0.16.0 ↔ midnight-js 4.1.1 / compact-js 2.5.x (see design.md §7)
* Midnight DApp Connector v4 — Lace and 1AM wallets (Chrome / Brave)
* Local proof server `midnightntwrk/proof-server:8.1.0` (loopback only, `docker compose up -d`)
* Offline `signer-tool` (separate repository `signer-tool`): Schnorr/Jubjub keys encrypted with scrypt + AES-256-GCM
* OpenZeppelin-style multisig pattern

## Clean architecture (kept)
`src/domain` (types) · `src/application` (use-cases, ports) · `src/infrastructure` (midnight-js, wallet, indexer,
storage, crypto, tooling) · `src/presentation` (UI, hooks, providers, i18n). Dependencies point inward.

## Roles
* **Contract Manager** — the account equal to the ledger `owner` (the deployer): deploy/registration, pause/unpause,
  `emergencyWithdraw`, and may also coordinate multisig operations.
* **Cosigner** — holds a signer key whose commitment is registered: authorises `mint`, `burn`, `contractWithdraw`,
  `setEmergencyPauser`, `setThreshold`, `rotateSigner` by signing **offline**.
* **Standard user** — anyone else: wallet transfers, `deposit`, balance and supply queries.

## Constraints (unchanged)
Performance, security, accessibility, SEO, i18n (en/fr), testing, clean architecture, TypeScript; cosigners sign off-chain
with the signer-tool; transactions and in-progress multisig requests are **persistent**.

## Network configuration (`midnight.config.json`)
| | |
|---|---|
| Network ID | `preprod` |
| Indexer | `https://indexer.preprod.midnight.network/api/v4/graphql` (WS `…/graphql/ws`) |
| Node RPC | `https://rpc.preprod.midnight.network` |
| Proof server | `http://127.0.0.1:6300` |
| Faucet / Explorer | `https://faucet.preprod.midnight.network` · `https://explorer.1am.xyz` |

## Relevant files
`contract/fungible_token_native_v3.compact` · `contract/tools/signer-tools.compact` · `contract/managed/` (build output) ·
`midnight.config.json` · `sdk/fungible-token-native-v3/` (generated) · `tests/` · `scripts/` (compile, deploy-cost,
check-contract, verify-manager-key) · `docker-compose.yml` · `.github/workflows/ci.yml`

---

## Implementation roadmap

### Phase 1 — Wallet and deployment ✅
- [x] Reusable wallet connector for **Lace and 1AM** (detect, connect with timeouts, status, **disconnect**)
- [x] Build & Deploy tab driven by `midnight.config.json`: compile → generate SDK → generate tests → run tests → deploy
- [x] Toolchain pin (0.31.1) with `scripts/compile.mjs` compat step
- [x] **Staged deploy** (4 circuits in the deploy tx, the rest by maintenance transactions) with resume from chain state
- [x] Deploy/registration progress panel; authority key export/import
- [x] Midnight theme, responsive layout

### Phase 2 — Contract operations and roles ✅
- [x] Role resolution and role-specific UI (manager / cosigner / user)
- [x] All circuits: `mint`, `burn`, `contractWithdraw`, `deposit`, `pause`, `unpause`, `emergencyWithdraw`,
      `setEmergencyPauser`, `setThreshold`, `rotateSigner`
- [x] **Native-token migration (v2.6 → v3):** wallets transfer natively; contract keeps issuance and its own holdings
- [x] Offline multisig flow: request → signer-tool approvals → in-app re-verification → submit (2-of-3 verified on-chain)
- [x] **Test Mode** (simulator, mock identities, replayed persistence) and **Wallet Mode**
- [x] Step-by-step progress for every action, including multisig operations
- [x] Persistent transaction history, multisig drafts, and **history backfill** from the indexer
- [x] Balances from the indexer (wallet UTXO replay) and ledger state (contract-held); **Lost tokens** card

### Phase 3 — Hardening ✅
- [x] **Schnorr challenge-reduction forgery** found, fixed (`Uint<8>`, `q <= 115`) and regression-tested
- [x] Stale/forgery-vulnerable contracts refused on open (verifier-key comparison, `CONTRACT_VERSION`)
- [x] Contract-address recipient refused on-chain and in the UI (live warning)
- [x] Content-Security-Policy; loopback-only tooling API; local-only proof server
- [x] Encrypted key backup/restore (scrypt + AES-256-GCM), import safeguards, replaced-key retention
- [x] `check-contract` and `verify-manager-key` scripts

### Phase 4 — Publication ✅
- [x] Repositories on GitHub: `fungible-token-workspace` (v3), `fungible-token-workspace-v2.6` (legacy), `signer-tool`
- [x] LICENSE, SECURITY.md, README quick start, pinned `docker-compose.yml`, CI (type-check + tests)
- [x] Secret scanning + push protection (enabled by the owner)
- [x] `design.md`, this plan

### Phase 5 — Remaining work (next steps, in suggested order)
1. **Repository settings (owner):** Dependabot, branch protection on `main` with the CI check required, private
   vulnerability reporting.
2. **Quality gates:** add an ESLint config (`next lint` is not configured) and a formatter; keep `npm test` + type-check in CI.
3. **Docs sync:** rewrite `staged_deployment.md` for v3 (10 circuits; `mint, deposit, pause, unpause` first, 6
   registrations after) and drop the "(in progress)" label in the README's v3 heading.
4. **Browser E2E tests:** Playwright against Test Mode (and a mocked DApp Connector for Wallet Mode flows).
5. **Accessibility and SEO audit** with real tools (axe, Lighthouse); fix findings.
6. **Scalability of reads:** cache/incrementally update the indexer UTXO replay (it re-reads a wallet's full history on
   every refresh) and paginate/cached history sync for contracts with many actions.
7. **Multi-contract support:** keep a list of known contracts and switch between them (today: one saved pointer).
8. **Nonce-based CSP** (remove `'unsafe-inline'` scripts) once dynamic rendering is acceptable.

## Still-missing features

**Contract / governance**
* No **authority handover or timelock**: whoever holds the maintenance key can replace verifier keys (trust point,
  decided out of scope; documented).
* **Treasury is fixed** at deploy (no `setTreasury`); signer count is fixed at 3 (no add/remove, only rotate).
* **Single-key owner powers:** the owner alone can pause and `emergencyWithdraw` contract-held tokens to the treasury.
  Options: require multisig for `emergencyWithdraw`, or a pause timelock.
* No per-period **mint caps / rate limits**, no batch mint, no pause granularity per circuit.
* No on-chain **token metadata registry**: wallets may show the raw token color rather than the name/symbol.
* v2.6 features intentionally dropped by the native model: `approve` / `transferFrom` allowances, account-based `burn`,
  `adminReallocate`.

**Key management**
* Identity and authority keys are stored **unencrypted** in browser storage (encrypted *backup* exists; encryption at
  rest, passphrase-gated unlock, or hardware/wallet-held keys do not).
* No in-app cosigner **key generation or signing** (signing stays offline by design; a guided desktop/CLI wrapper or QR
  exchange of request/approval files would ease coordination).

**App**
* Coordinator experience: request/approval exchange is file or paste based (no share link/QR, no inbox of pending
  requests from other coordinators).
* Chain-synced history rows show the circuit, block and hash but not the operation arguments (recipient, amount).
* Wallet-to-wallet transfers are not part of the contract's history (they do not touch the contract).
* Only English and French; no automated accessibility/performance budget.

**Platform / ecosystem**
* **Mainnet readiness:** third-party audit, network switching beyond preprod, production hosting guidance (the app is
  designed to run locally because proofs need the user's own prover).
* **Toolchain upgrade** to the async runtime (compiler ≥ 0.34, compact-runtime ≥ 0.19) once midnight-js supports it.
* Parity for the legacy v2.6 repository (CSP, CI, compose) is deliberately not planned — it carries a warning instead.
