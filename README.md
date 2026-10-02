# FungibleToken (native) — Midnight DApp

Next.js 15 (App Router) / React 19 client for `contract/fungible_token_native_v3.compact` on Midnight **preprod**.
The token is a native unshielded Midnight token: wallets hold and transfer it; the contract governs minting (2-of-3 multisig) and its own holdings.
(`contract/fungible_token_v2.6.compact` is the previous internal-ledger version, kept for reference; the app no longer uses it.)

```
src/domain          types, roles, amounts, multisig file formats (pure)
src/application     use-cases + ports (TokenService, MultisigService, validation)
src/infrastructure  midnight-js, wallet connector, simulator, storage, tooling, crypto
src/presentation    React UI, providers, i18n (en/fr)
src/app             routes: /, /api/tooling, /zk/[...path]
```

## Commands
| | |
|---|---|
| `npm run dev` | dev server |
| `npm test` | vitest (simulator, multisig, services, wallet connector, generators) |
| `npm run typecheck` / `npm run build` | tsc / production build |
| `npm run compile:contract` / `compile:tools` | `scripts/compile.mjs`: compiles with the compiler pinned in `midnight.config.json` (`contract.compilerVersion`, default 0.31.1) |

The **Build & Deploy** tab drives the same steps from `midnight.config.json`
(compile → generate SDK → generate tests → run tests → deploy). Tooling routes spawn local
processes, so they are loopback + same-origin only and disabled in production unless `MIDNIGHT_TOOLING=1`.

## Modes
- **Test Mode**: compiled circuits run locally through `compact-runtime` with mock identities (manager, Alice, Bob, 3 cosigners). State persists across reloads by replaying recorded calls.
- **Wallet Mode**: Lace / 1AM via the DApp Connector; proofs from the local proof server (`127.0.0.1:6300`); the wallet balances and submits. Start it with `npm run proof-server:start` (needs a `docker-compose.yml`, not included).

## Roles
Manager = account equal to ledger `owner`; Cosigner = holds a signer key whose commitment is registered; else Standard user.
The contract's `authenticate()` needs a 32-byte secret wallets don't expose, so the app keeps a local token-identity key
(**Overview → Identity**: back it up; losing it loses the account).

## Multisig (offline)
Manager/cosigner builds a request (bound to contract address + current nonce) → cosigners sign **offline** with
`../signer-tools` (`signer-tool sign …`) → upload approvals; each is re-verified in the app against a digest it recomputes itself → submit.
Signer public keys for deployment come from `signer-tool keygen`.

## Toolchain note (important)
`@midnight-ntwrk/midnight-js-*` 4.1.1 (compact-js 2.5.x) only runs contracts built for **compact-runtime 0.16.0**, i.e. compiler **0.31.x**:
contracts from compiler 0.34 (runtime 0.19) return async code that compact-js can't consume, and deploy fails with
"Failed to configure constructor context with coin public key". The v2.6 source needs just one change for 0.31.x — the two
`as JubjubScalar` casts (a type that exists from 0.34) — which `scripts/compile.mjs` strips into `contract/.compat/` (your source is untouched).
Move to compiler 0.34+ only together with a midnight-js release built for it (5.x is still alpha/rc).

## Staged deploy (block limits)
Deploying all 12 circuits in one transaction (~28 KB of verifier keys) was rejected by preprod with
`1010: Invalid Transaction: Transaction would exhaust the block limits`. The app now deploys only the circuits in
`contract.deployCircuits` (midnight.config.json) and registers each remaining verifier key in its own small maintenance
transaction (shown as steps in the deploy progress). If registration stops midway, the **Register remaining circuits**
button on the Overview tab resumes it. `npm run deploy:cost [-- --circuits a,b]` estimates a deploy's block usage offline.

## Decisions & known limits
- **No maintenance-authority handover (decided).** The deploy-time authority key (kept in the deploying browser's storage) can insert/remove
  circuit verifier keys, so it is a trust point above the multisig. Accepted for now; protect/back up that browser profile.
- **`setThreshold` is deferred** to a future contract version (the threshold stays fixed after deploy). If added later it must be
  multisig-gated like `mint`, then registered through the existing "Register remaining circuits" flow.

## v3 — native unshielded token (in progress)
`contract/fungible_token_native_v3.compact` (compile: `node scripts/compile.mjs native`, output `contract/managed/fungible-token-native-v3`).
- The token is a **native Midnight unshielded token**; wallets hold and transfer it themselves (wallet → wallet needs no circuit).
- Circuits: `mint` (multisig → wallet address), `burn` (multisig, contract-held tokens only), `deposit` (anyone: wallet → contract-held),
  `contractWithdraw` (multisig: contract-held → wallet), `emergencyWithdraw` (owner, paused → fixed `treasury` wallet),
  `setEmergencyPauser`, `rotateSigner`, `pause`, `unpause`.
- `pause` gates only contract-mediated actions; it cannot stop native wallet-to-wallet transfers.
- Unused approval slots use the identity point `(0,1)` (valid for the real prover), so threshold-2 needs only 2 signatures.
- Tested through the real compiled circuits (`tests/native-v3.test.ts`); on-chain token movement still needs a preprod run.
- Deploy cost: all 9 circuits ≈ 22 KB (54% of a block's write budget) — use the staged deploy (core circuits first).
- The app is migrated to v3 (v2.6 screens removed). Not yet exercised on preprod: wallet-funded `deposit`, wallet `makeTransfer` of this token, and real-prover acceptance of identity-padded approval slots.
