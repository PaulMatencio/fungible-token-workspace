# Staged deployment (v3)

Midnight contracts store, for each callable circuit, its **verifier key**: what the chain uses to check the ZK proof
when someone calls that circuit. A normal deploy writes the whole contract in one transaction — the initial ledger
state plus every verifier key. A **staged deploy** splits that into several smaller transactions.

The v3 contract has **10 circuits**: `mint`, `burn`, `contractWithdraw`, `deposit`, `emergencyWithdraw`, `pause`,
`unpause`, `setEmergencyPauser`, `setThreshold`, `rotateSigner`.

## The two phases

**Phase 1 — deploy a smaller contract (1 transaction)**
* The app builds the deploy transaction as if the contract had only four circuits: `mint`, `deposit`, `pause`, `unpause`
  (`contract.deployCircuits` in `midnight.config.json`). `mint` is there so tokens can be issued right away; `pause` and
  `unpause` so the contract can be stopped from the first block.
* Only those four verifier keys go into the transaction. The contract's initial state (name, symbol, decimals, max
  supply, treasury, signer commitments, threshold) is in the same transaction; the constructor runs here.
* The transaction also records a **maintenance authority key**. Only its holder can add or replace verifier keys later.
  The app generates it at deploy time and keeps it in the browser's local storage (`ft:sk:<contract address>`).

**Phase 2 — register the other circuits (6 transactions)**
* The app compares the circuits registered on-chain with the full list and finds the missing ones:
  `burn`, `contractWithdraw`, `emergencyWithdraw`, `rotateSigner`, `setEmergencyPauser`, `setThreshold`.
* For each one it sends a small **maintenance transaction** that inserts that circuit's verifier key. Each is signed with
  the authority key, balanced by the wallet, and paid in DUST.
* Expect about **7 wallet approvals** in total (1 deploy + 6 registrations). Each shows in the progress panel, for
  example `Register circuit "contractWithdraw" (2/6)`.

## Why not one transaction?
Deploying v2.6 with all 12 verifier keys (about 28 KB) was rejected by preprod with
`Transaction would exhaust the block limits`. A local estimate (`npm run deploy:cost`) for v3:

| Deploy carries | Serialized size | Block usage | Bytes written (of one block) |
|---|---|---|---|
| 4 circuits (what the app sends) | 10,777 B | 5.4 % | 32 % |
| all 10 circuits | 24,325 B | 12.1 % | 59 % |

All 10 would probably fit under the estimate, but the estimate is not the node's verdict, and the original failure
happened at a similar size. Staging keeps the first transaction well inside the limit; a circuit that is not registered
yet simply cannot be called, because the chain has no key to verify its proofs.

## What the app has to handle
* **A smaller contract object.** The deploy library takes the verifier-key list from the contract's circuit list, so the
  app hands it a copy of the contract that exposes only the four core circuits (`SubsetContract` in
  `infrastructure/contract/compiled.ts`).
* **Placeholder operations.** The generated constructor creates an empty operation for every circuit. Operations with no
  key make the node reject the transaction (`Custom error: 110`, "VerifierKeyNotSet"), so the app rebuilds the initial
  state with only the four kept operations before building the transaction.
* **Opening the contract.** midnight-js checks that every circuit of the definition it is given has a matching on-chain
  key. While some keys are pending, the app therefore opens the contract with **only the registered circuits**, and
  switches to the full definition once everything is registered.
* **Confirmation.** If the indexer stalls, the app confirms a registration from the chain state instead of waiting.

## If something stops midway
The contract address is saved the moment phase 1 confirms, so nothing is lost if phase 2 fails (wallet closed, tab
reloaded, a transaction refused). The Overview tab then shows a yellow notice with the unregistered circuits and a
**Register remaining circuits** button that runs **only the missing registrations**; after a reload the notice comes back,
because the app asks the chain which circuits are registered. This was needed in practice: a `contractWithdraw`
registration was refused by the wallet at submission, and retrying the button completed the remaining circuits.

You can check the same thing from a terminal:

```bash
npm run check:contract -- <contract address>      # "Registered (n/10)" and "Missing (…)"
```

## Authority key custody
The authority key can change what the contract does, and it exists only in this browser. After deploying:
* export it (**Identity → Contract authority key → Export**), or download the **encrypted backup**, which includes it;
* keep the backup with the passphrase stored separately.
If the key is lost the contract keeps working, but no circuit can be added, replaced or removed any more.

## Adding or replacing a circuit later
A registration is the same operation as an addition: `submitInsertVerifierKeyTx` signed with the authority key. Replacing a
circuit's logic is a remove (`submitRemoveVerifierKeyTx`) followed by an insert. Limits:
* the **ledger layout is fixed at deploy**, so a new circuit can only use state the contract already has;
* the app's compiled contract must contain the circuit (recompile, regenerate the SDK);
* registering a circuit that was in the original build is proven on preprod; inserting one that was **not** in the build the
  contract was deployed from is the same call but has not been exercised here.
`setThreshold` was added by redeploying, because the Schnorr security fix changed the keys of five circuits anyway; the
app refuses contracts whose registered keys differ from the local build (`CONTRACT_VERSION`).

## What it changes
* The 10 circuits and the contract logic are identical to a single-transaction deploy.
* Until phase 2 finishes, only `mint`, `deposit`, `pause` and `unpause` work.
* Cost: more transactions, so more DUST fees and more wallet approvals.

You can change the core list in `midnight.config.json`: a shorter list gives a smaller first transaction, a longer one
means fewer registrations but a bigger first transaction. Re-run `npm run deploy:cost -- --circuits a,b,c` to see the
effect before deploying.

## Verification status
Verified on preprod with the v3 contract: the 4-circuit deploy, the registration of the remaining circuits (including a
retry after a refused submission), and 10/10 registered afterwards. Proven locally: the shape of the first transaction
(the right four operations, each with a key) and its block-usage estimate.
