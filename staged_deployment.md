## How staged deployment works

Midnight contracts store, for each callable circuit, its **verifier key**: the thing the chain uses to check the ZK proof when someone calls that circuit. A normal deploy writes the whole contract into one transaction: the initial ledger state plus all 12 verifier keys. Staged deploy splits that into several smaller transactions.

## The two phases

**Phase 1: deploy a smaller contract**
- The app builds the deploy transaction as if the contract had only four circuits: `transfer`, `approve`, `transferFrom`, `selfBurn`. This is the `contract.deployCircuits` list in `midnight.config.json`.
- Only those four verifier keys go into the transaction, so it is about 11 KB instead of 28 KB. By my local estimate that is about a third of a block's write budget, not two thirds.
- The contract's initial state (name, symbol, signers, threshold and so on) is in this transaction, and the constructor runs here.
- The transaction also records a **maintenance authority key**. Only the holder of this key can add more verifier keys later. The app generates it at deploy time and stores it in the browser's local storage, next to the saved contract address.

**Phase 2: register the other circuits**
- The app compares the circuits registered on-chain with the full list of 12 and finds the missing ones.
- For each missing circuit it sends a small **maintenance transaction** that inserts that circuit's verifier key. Each one is signed with the authority key from phase 1, and the wallet balances it and pays the DUST fee.
- That makes up to 8 extra transactions, so expect about 9 wallet approvals in total. Each appears in the progress panel as `Register circuit "mint" (2/8)`.

## Why not one transaction?
The node rejected the all-in-one deploy with `Transaction would exhaust the block limits`. Splitting keeps each transaction well under the limit. A circuit that isn't registered yet can't be called, because the chain has no key to verify its proofs.

## What I had to handle
- **Smaller contract object.** The deploy library takes the verifier-key list from the contract's circuit list, so the app hands it a copy of the contract that exposes only the four core circuits.
- **Placeholder operations.** The generated constructor creates an empty operation for all 12 circuits. Those with no key attached make the node reject the transaction (that was the `Custom error: 110`). So the app rebuilds the initial state with only the four kept operations before building the transaction.
- **Full contract afterwards.** As soon as phase 1 confirms, the app reconnects using the full 12-circuit contract, so every circuit becomes callable once its key is registered.

## If something stops midway
The contract is saved right after phase 1 confirms. If phase 2 fails (the wallet is closed, the tab is reloaded, a registration is rejected), nothing is lost. The Overview tab then shows a yellow notice listing the unregistered circuits and a **Register remaining circuits** button, which runs only the missing registrations. After a reload the notice comes back, because the app asks the chain which circuits are registered.

## What it changes
- The 12 circuits and the contract logic are the same as before.
- Until phase 2 finishes, only the four core circuits work. `mint`, `burn`, `pause` and the others stay unavailable.
- Cost: more transactions, so more DUST fees and more wallet approvals.

You can change the core list. A shorter list gives a smaller first transaction. A longer one means fewer registration steps but a bigger first transaction.

I tested the shape of the first transaction locally: the right four operations, each with a key, and a lower block-usage estimate. The phase 2 maintenance transactions have not run against the real network yet, so that part is unproven.


###  Adding a circuit later on 

What the mechanism allows
A deployed Midnight contract keeps a list of circuits with their verifier keys. The maintenance authority can add keys to that list, remove them, or replace the authority. The "Register remaining circuits" step is exactly that, so you could add a setThreshold circuit later.

What it would take
Write the circuit in the contract. setThreshold would take a new threshold plus the 1–3 approvals and a nonce, like mint does. It could write to the existing _multisigThreshold ledger field. The v2.6 header lists "the threshold cannot be changed after deployment" as a known limitation, so this is the natural fix.
Recompile. That produces the new circuit's verifier key. Because the circuit uses only the ledger fields that already exist, the stored ledger layout stays the same. A circuit that needs a new ledger field can't be added this way, since the stored state has no slot for it.
Register its key with a maintenance transaction. The app already treats any circuit missing on-chain as "to register", so the same button would handle it.
Update the client. Regenerate the SDK, add the signing-request type to the signer-tool and its SignerTools copy of the digest, and add the UI form.
Where it can go wrong
Recompiling can change the keys of circuits you already registered. If the compiler produces a different key for an unchanged circuit, proofs from your new build won't match the key on-chain. You would then have to remove and re-insert that key. I haven't tested whether that happens for this contract, so check it before relying on it.
Existing deployed state is not migrated. Only the list of callable circuits changes.
The important security point
The authority that can insert keys can also add a circuit that bypasses the multisig, for example a mintAnything with no approvals. The app currently creates one authority key at deploy time and keeps it in the browser's local storage. That makes it a single point of control over the whole contract, and it undermines the 2-of-3 design. Before this goes beyond testing, you should either:

replace the authority with a committee key set that needs several signers, or
hand it to the cosigners, or
once all circuits are registered, replace it with a key nobody holds, which makes the circuit set permanent but also blocks adding setThreshold later.