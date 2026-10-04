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

## Quick start (preprod, Wallet Mode)
Prerequisites: Node 22, Docker, the Compact compiler **0.31.1** (`compact update 0.31.1`), and a Midnight wallet
(Lace or 1AM) on preprod with tDUST.

```bash
git clone git@github.com:PaulMatencio/fungible-token-workspace.git && cd fungible-token-workspace
npm ci
npm run proof-server:start     # local prover on 127.0.0.1:6300 — keep it local (see SECURITY.md)
npm run compile:contract       # builds the circuits and the proving keys (*.prover are not committed)
npm run dev                    # http://localhost:3000 → connect the wallet → Build & Deploy
```

Run the app **locally** rather than hosting it publicly: proofs must come from your own prover (proof requests include
your secret key), and `/api/tooling` spawns local processes. `npm run check:contract -- <address>` inspects a deployed
contract; `npm run verify:manager-key -- <address>` checks that a secret key is a contract's manager. Report security
issues privately — see [SECURITY.md](SECURITY.md).

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
- **Wallet Mode**: Lace / 1AM via the DApp Connector; proofs from the local proof server (`127.0.0.1:6300`); the wallet balances and submits. Start it with `npm run proof-server:start` (uses the committed `docker-compose.yml`, pinned to `midnightntwrk/proof-server:8.1.0` and bound to loopback only).

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

## v3 — native unshielded token
`contract/fungible_token_native_v3.compact` (compile: `node scripts/compile.mjs native`, output `contract/managed/fungible-token-native-v3`).
- The token is a **native Midnight unshielded token**; wallets hold and transfer it themselves (wallet → wallet needs no circuit).
- Circuits: `mint` (multisig → wallet address), `burn` (multisig, contract-held tokens only), `deposit` (anyone: wallet → contract-held),
  `contractWithdraw` (multisig: contract-held → wallet), `emergencyWithdraw` (owner, paused → fixed `treasury` wallet),
  `setEmergencyPauser`, `setThreshold` (multisig: change the 1..3 approval threshold without redeploying), `rotateSigner`, `pause`, `unpause`.
- `pause` gates only contract-mediated actions; it cannot stop native wallet-to-wallet transfers.
- Unused approval slots use the identity point `(0,1)` (valid for the real prover), so threshold-2 needs only 2 signatures.
- Tested through the real compiled circuits (`tests/native-v3.test.ts`); on-chain token movement still needs a preprod run.
- Deploy cost: all 9 circuits ≈ 22 KB (54% of a block's write budget) — use the staged deploy (core circuits first).
- The app is migrated to v3 (v2.6 screens removed). Not yet exercised on preprod: wallet-funded `deposit`, wallet `makeTransfer` of this token, and real-prover acceptance of identity-padded approval slots.

## Security note — Schnorr challenge reduction (fixed 2026-10-03)

Earlier builds of this contract (and of v2.6) let a prover choose the Schnorr challenge: the witness quotient `q` was an
unbounded `Field`, so `q·2²⁴⁸ + c == cFull` held for any `c` and approvals could be forged from the signers' **public**
keys alone (`tests/forgery.test.ts` reproduces the attack). The circuit now types `q` as `Uint<8>` and asserts
`q <= 115`. `mint` / `contractWithdraw` also refuse the contract's own address on-chain.

* **Contracts deployed before the fix must not be used** (their `mint`, `burn`, `contractWithdraw`,
  `setEmergencyPauser`, `rotateSigner` verifier keys differ). The app detects them (`CONTRACT_VERSION`), forgets the
  saved pointer and asks for a new deployment.
* Trust assumptions that remain: the maintenance authority key (browser localStorage, `ft:sk:<address>`) can replace
  verifier keys; the owner can pause and `emergencyWithdraw` contract-held tokens to the fixed treasury on their own.

## Encrypted key backup

**Identity** card → *Encrypted backup*: downloads a passphrase-protected JSON file (scrypt N=2¹⁷ r=8 p=1 → AES-256-GCM, the
same scheme as the signer-tool key files, metadata bound as AAD) holding the identity secret key and, when this browser
has it, the open contract's authority key. *Restore* decrypts a file and re-imports both (a replaced key is kept under
`…:replaced:<timestamp>`). Minimum passphrase length 12; the passphrase cannot be recovered. See
`src/infrastructure/crypto/keyBackup.ts`.
