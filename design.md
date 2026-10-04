# Design — FungibleToken (native) on Midnight

Design notes for the v3 contract and its Next.js client. For setup and commands see [README.md](README.md); for the
security policy see [SECURITY.md](SECURITY.md); for the staged-deploy background see
[staged_deployment.md](staged_deployment.md) (written for v2.6, the mechanism is unchanged).

## 1. Goals and scope

* A **native unshielded Midnight token** whose issuance and treasury are governed by an offline **k-of-3 multisig**.
* A browser DApp (React 19 / Next.js 15 App Router) for **Midnight preprod** with two modes: **Test Mode** (circuits run
  locally against mock identities) and **Wallet Mode** (Lace or 1AM, live on-chain).
* The app also drives the contract's build pipeline (compile → SDK → tests → deploy) from `midnight.config.json`.
* Non-goals: mainnet use (not audited), shielded balances, a hosted multi-user service.

## 2. System overview

```
 ┌──────────── browser (localhost:3000) ────────────┐        ┌─ offline machine(s) ─┐
 │  Next.js app  ──  domain / application /         │        │ signer-tool (CLI)    │
 │                   infrastructure / presentation  │◀──────▶│ keygen · pubkey ·    │
 │  localStorage: identity, authority key, tx log   │ JSON   │ sign (encrypted keys)│
 └───┬───────────────┬──────────────────┬───────────┘ files  └──────────────────────┘
     │ DApp Connector│ HTTP             │ GraphQL / WS
     ▼               ▼                  ▼
  Lace / 1AM     proof server        indexer ── Midnight node (preprod)
  (balance,      127.0.0.1:6300
   sign, submit) (Docker, local only)
```

* The **wallet** balances transactions, pays DUST, signs and submits. It never sees the token secret key.
* The **proof server** is always local (§9). The **indexer** serves contract state, history and UTXO data.
* **Cosigners** sign request files offline; the app only ever receives public approval files.

## 3. Token model

The token is a native unshielded token. Its **color** is `tokenType(pad(32,"fungible-token:native"), kernel.self())`,
so it is unique to the contract and equal to what wallets display.

| Action | Who / how | Contract involved? |
|---|---|---|
| Hold, receive, **wallet → wallet transfer** | any wallet, via the wallet's own transfer (`makeTransfer`) | no — no circuit, no proof, cannot be paused |
| `mint` | k-of-3 multisig → pays a wallet address | yes |
| `deposit` | anyone, wallet → contract-held balance | yes (`receiveUnshielded`) |
| `contractWithdraw` | k-of-3 multisig, contract-held → wallet | yes |
| `burn` | k-of-3 multisig, **contract-held** tokens → all-zero address | yes |
| `emergencyWithdraw` | owner only, while paused, → fixed `treasury` wallet | yes |

Consequences: `pause` only gates contract-mediated actions; tokens in wallets cannot be burned by the contract; tokens
sent to the all-zero address (burn) or to the contract's own address (mistake) are unspendable — the app shows both in
a *Lost tokens* card and the circuits refuse the contract address as a recipient.

Balances: a **wallet's** balance is replayed from the indexer's `unshieldedTransactions` UTXO stream (created − spent);
the **contract's** held balance is read from the ledger `ContractState.balance` (the indexer's per-contract field stays
empty after a deposit — verified on preprod).

## 4. Contract design (`contract/fungible_token_native_v3.compact`)

### 4.1 Ledger state
`_totalSupply`, `_maxSupply`, `_name`, `_symbol`, `_decimals`, `owner` (hash-derived manager account), `treasury`
(wallet bytes), `_contractSalt`, `_paused`, `_emergencyPauser`, and the multisig set: `_multisigSigners` (commitments),
`_multisigThreshold`, `_multisigSignerCount` (fixed 3), `_multisigNonce` (Counter).

### 4.2 Circuits (10)
`mint`, `burn`, `contractWithdraw`, `setEmergencyPauser`, **`setThreshold`**, `rotateSigner` (multisig-governed);
`pause`, `unpause` (owner or emergency pauser); `deposit` (anyone); `emergencyWithdraw` (owner, paused).
`mint`, `deposit`, `contractWithdraw`, `burn` are blocked while paused; `rotateSigner` and `setThreshold` are not
(governance/recovery path).

### 4.3 Accounts and authentication
`account = persistentHash(["fungible-token:auth", salt, secretKey])`. The secret key is a **witness**
(`localSecretKey`) supplied by the app; wallets do not expose such a key, so the app keeps its own (§10). A wallet
address and a token account are unrelated: the account only authenticates owner/pauser actions.

### 4.4 Multisig (OpenZeppelin-style, privacy-preserving)
* Signers are Schnorr keys on the **Jubjub** curve. The chain stores only **commitments**
  `persistentHash(["multisig:signer:", salt, x, y])`; public keys are private circuit inputs.
* Every governed operation hashes `(tag, contractAddress, nonce, …arguments)` — e.g. `"multisig:mint:"` — so an
  approval is bound to one contract, one nonce and one set of arguments. The nonce increments on every operation.
* `assertApprovals` takes 3 `(pubkey, signature)` slots. Unused slots carry the curve **identity point (0,1)** and count
  as 0 (v2.6 used (0,0), which the real prover rejects, forcing all 3 signatures). Duplicate signers are rejected, every
  populated slot must be a registered commitment with a valid signature, and the valid count must reach the threshold.
* `setThreshold(1..3)` changes k without redeploying (signer count stays 3); `rotateSigner` replaces one signer, proving
  possession of the incoming key.
* **Challenge reduction.** The Schnorr challenge is truncated to 248 bits via a witness `[q, c]` checked by
  `q·2²⁴⁸ + c == cFull`. `q` is typed `Uint<8>` and asserted `<= 115`; an unbounded `Field` quotient let a prover choose
  the challenge and forge approvals from public keys alone (fixed 2026-10-03, `tests/forgery.test.ts`).

## 5. Offline signing flow

1. The **coordinator** (manager or cosigner) builds a *request* in the app; the app computes the digest itself with the
   compiled signer-tools circuits (no hand-written hashing).
2. Each **cosigner** runs `signer-tool sign --key … --request …` offline (key file encrypted: scrypt + AES-256-GCM) and
   returns an *approval* JSON containing the public key and signature.
3. The app **re-verifies** each approval (digest, signature, registered commitment, no duplicates, nonce still current)
   and submits when the threshold is met. Drafts persist across reloads. No secret ever passes through the app.

## 6. Application architecture

```
src/domain          pure types: token state, circuit table, roles, multisig formats, errors, amounts
src/application     use-cases + ports: TokenService, MultisigService, validation, progress trackers
src/infrastructure  adapters: gateways, wallet connector, indexer readers, storage, crypto, tooling, config
src/presentation    React UI, providers, hooks, components, i18n (en / fr)
src/app             routes: /  ·  /api/tooling  ·  /zk/[...path]  ·  robots
```

Dependencies point inward. `application` depends only on **ports** (`TokenGateway`, `KeyValueStore`, `SignerCrypto`,
`TxLogPort`); `infrastructure` implements them.

* **`TokenGateway`** has two implementations: `SimulatorGateway` (Test Mode — runs the compiled circuits through
  `compact-runtime`, keeps its own accounting for token movements, persists by **replaying recorded calls**) and
  `ChainGateway` (Wallet Mode — midnight-js `findDeployedContract`, wallet providers, local proof server).
* **Roles** (`domain/roles.ts`): *Manager* = account equals ledger `owner`; *Cosigner* = holds a signer key whose
  commitment is registered; *User* = everyone else. The UI shows each role its own circuits (`CIRCUITS` table); the
  contract still enforces authority itself.
* **Tracked actions:** every action runs through `runTracked`, which feeds a step panel (verify → build → prove → balance
  → submit → confirm) that stays visible after success or failure, for deploys, circuit calls and multisig operations.
* **Errors** are typed (`AppError` codes) and mapped to friendly messages; wallet/node errors are unwrapped to the node's
  actual reason where available.
* The chain code (midnight-js, WASM) is **lazily imported**, so Test Mode and the shell load without it.

## 7. Build and deploy pipeline

`midnight.config.json` drives everything: network endpoints, the contract source/name/managed dir, `compilerVersion`,
and `deployCircuits`. The **Build & Deploy** tab runs compile → generate SDK → generate tests → run tests → deploy through
`/api/tooling` (loopback and same-origin only; disabled in production unless `MIDNIGHT_TOOLING=1`).

* **Toolchain pin.** midnight-js 4.1.1 / compact-js 2.5.x expect the synchronous runtime 0.16.0, so the contract is
  compiled with **0.31.1** (`scripts/compile.mjs` strips the `as JubjubScalar` casts into `contract/.compat/` for
  compilers < 0.34). Newer compilers emit async code the libraries cannot run.
* **Staged deploy.** A deploy carrying all verifier keys exceeded the block limit, so the deploy transaction carries only
  `deployCircuits` (`mint, deposit, pause, unpause`); the remaining circuits are registered by maintenance
  transactions signed with the **authority key** generated at deploy time. The app rebuilds the initial contract state with
  only the chosen operations (placeholders without a key make the node reject the transaction) and, when opening a
  contract, uses only the circuits actually registered. The contract address is saved the moment phase 1 confirms; a
  *Register remaining circuits* button resumes from chain state after any interruption.
* **Version safety.** On open the app compares every registered circuit's verifier key with the local build and refuses a
  contract from a different build (`CONTRACT_VERSION`) — this is how contracts deployed before the security fix are
  rejected. `npm run check:contract` shows the same facts from a terminal.

## 8. Wallet integration

* DApp Connector API v4 for **Lace** and **1AM**, wrapped in a reusable `connector` (detect, connect with timeouts,
  status, **disconnect**); endpoints come from the wallet's own configuration.
* The wallet supplies shielded keys (Bech32m, decoded to hex for the constructor context), balances and submits
  transactions. Wallet → wallet token transfers use the wallet's `makeTransfer`.
* Address handling: Bech32m `mn_addr_…` ⇄ the 32 raw bytes the circuits take; the UI converts on submit and warns live
  if the contract's own address is typed as a recipient.

## 9. Proof server

Proofs are generated only by a **local** proof server (`docker-compose.yml`, pinned `midnightntwrk/proof-server:8.1.0`,
bound to `127.0.0.1:6300`). A proof request carries the circuit's private inputs, including the token secret key, so the
app never uses a wallet-hosted or remote prover (a shared remote prover also failed on these circuits). The app checks
`/health` before proving.

## 10. Data and persistence

All client state is in `localStorage` under the `ft:` prefix (in-memory fallback):

| Key | Content |
|---|---|
| `identity:secretKey` | app identity key (plain hex) |
| `identity:signerPubkey` | the user's cosigner public key |
| `deployment:current` | address of the open contract |
| `sk:<contract>` | maintenance authority key of that contract |
| `tx:<id>` | transaction log (≤ 200, newest first) |
| `multisig-draft:<contract>` | in-progress signing request and approvals |

* **History** survives reloads and is **backfilled from the indexer** (`contractActions`) on connect and via *Sync from
  chain*, deduplicated by transaction hash.
* **Backups:** *Display secret key* only shows the key. *Encrypted backup* downloads a passphrase-protected file
  (scrypt N=2¹⁷ r=8 p=1 → AES-256-GCM, metadata as AAD, 12+ character passphrase) holding the identity key and, when
  present, the authority key; *Restore* re-imports both and keeps any replaced key under a timestamped entry. Importing a
  value that equals a known account is refused (it once overwrote a real key).

## 11. Security model

| Threat | Mitigation |
|---|---|
| Forged / replayed approvals | bounded Schnorr reduction; digests bound to contract + nonce + arguments; app re-verifies |
| Secret key exposure to a remote prover | local proof server only, loopback-bound |
| Exfiltration / script injection | CSP (`connect-src` limited to the indexer, node, Midnight/1AM hosts, local prover); no `eval` in production; other security headers |
| Tooling endpoint abuse | loopback + same-origin only; off in production by default |
| Tokens lost to a bad recipient | on-chain and UI refusal of the contract address; zero address refused; lost-tokens card |
| Using an old, forgeable contract | verifier-key comparison on open (`CONTRACT_VERSION`) |
| Secrets in the repo | whitelist `.gitignore` in the signer-tool repo; secret scanning + push protection on GitHub |

**Trust assumptions (by design):** the authority key can change what the contract does and sits unencrypted in browser
storage; the owner alone can pause and `emergencyWithdraw` contract-held tokens to the fixed treasury; there is no
authority-handover circuit. See [SECURITY.md](SECURITY.md).

## 12. UX, i18n, accessibility, SEO, performance

* Midnight theme (dark) with Tailwind; tabs: Overview, Build & Deploy, Operations, History; responsive down to phone width.
* **i18n:** typed message keys with English and French catalogues.
* **Accessibility:** labelled inputs, `role="alert"/"status"` banners, an `aria-live` region for messages,
  `aria-selected` tabs, keyboard-operable controls and visible focus rings.
* **SEO:** page metadata with Open Graph tags, and `robots` rules (`/api/` and `/zk/` disallowed).
* **Performance:** lazy-loaded chain code, a statically prerendered page shell, and contract state refreshed every 15 s
  (plus after every action).

## 13. Testing

`npm test` (vitest, 85 tests, runs in CI on a clean clone with no compiler or proving keys):
simulator circuit tests (multisig, pause, deposit/withdraw/burn, `setThreshold`), service-level flows, the forgery
regression, compiled-contract/subset checks, wallet-connector behaviour, key backup, and generated interface tests from
the SDK generator. On-chain behaviour was verified manually on preprod for every circuit.

## 14. Decisions and limits

* **Native token over an internal ledger (v2.6):** wallets hold and transfer the token themselves; the contract keeps
  issuance and treasury only. v2.6 stays in its own repository as a legacy reference (it has the Schnorr flaw).
* **Fixed signer count (3)**; k adjustable with `setThreshold`; replacing signers via `rotateSigner`.
* **No authority handover** and **no upgrade path** beyond registering/replacing verifier keys with the authority key.
* **Pause cannot stop wallet transfers** — inherent to a native token.
* **Toolchain pinned at 0.31.1** until midnight-js supports the async runtime; revisit on upgrade.
* **Open ideas:** encrypting the stored keys at rest, a nonce-based CSP, a handover or timelock for the authority key.
