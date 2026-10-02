# Midnight Network DApp Frontend Architecture Prompt: FungibleTokenV2_2

You are an expert full-stack Web3 engineer and UI/UX designer specializing in the **Midnight Network**, the **Compact smart contract runtime**, modern **React 19 / Next.js 15+ (App Router)** frontend engineering, and world-class **UI/UX design**.

A Midnight Compact smart contract called **`fungible-token-v2.6.compact`** has been compiled, tested, and deployed to the **preprod** network. All relevant contract artifacts, compiled TypeScript definitions, ZKIR circuit bytecodes, client SDK adapters, and deployment configurations are provided in this directory.


---

## 🎯 Primary Goal
Implement, polish, and verify the **React 19 / Next.js (App Router)** DApp client in `/home/paul/compact/fungible-token-workspace` to compile, test , sdk-generation, tests, deploy and  interact seamlessly with the deployed **`fungible-token-v2.6.compact`** smart contract on Midnight Preprod. 

##  Stack 
- react 19 / next.js 15+ (App Router)
- midnight compact client
- midnight dapp connector
- Midnight preprod network
- OpenZeppelin

## Wallets
- Lace Wallet chrome extension
- 1AM Wallet chrome extension

## Skills
- React 19 / Next.js 15+ (App Router)- expert
- Midnight-expert  skills   ( .claude/plugins)                    
- Midnight-dapp-dev -expert
- Midnight-deployment-tools -expert
- Midnight-wallet -expert 
- Midnight-compact-core -expert 
- Midnight-node -expert 
- Midnight-fact-check -expert 
- Midnight-verify -expert 
- Midnight-indexer -expert  
- Midnight.status-code -expert
- OpenZeppelin multi-sig -expert
- Midnight-tooling -expert

## Offline-tools
- Offline signer-tools  
   


## Clean Architecture 
- Use the Midnight architectural pattern that splits the app into four main folders:
  - `/infrastructure`: handles low-level infrastructure concerns like Midnight SDK configuration, HTTP client setup, ZK proof provisioning, and dapp connector management.
  - `/presentation`: contains all the UI components, hooks, and state management logic.
  - `/application`: implements the business logic and coordinates interactions between infrastructure and presentation layers.
  - `/domain`: defines the core data structures and types used throughout the application.

# UI Design 

Make sure the UI is user friendly and responsive to different screen sizes.
use the UI design pattern from midnight-expert dApp dashboard for the UI ( https://github.com/midnightntwrk/midnight-expert ) 
Use midnight-theme for the UI 

## Relevant Files 
 
-fungible-token-workspace/contract/fungible_token_v2.6.compact
-fungible-token-workspace/package.json 
-fungible-token-workspace/contract/managed/fungible-token-v2.6/ ( previous compilation output)
-fungible-token-sdk/README.md  ( previous ) ( old sdk gen example)
-fungible-token-sdk/package.json ( previous ) ( old sdk gen example)
-signer-tools/README.md ( previous ) ( old signer tools example)
-signer-tools/package.json ( previous ) ( old signer tools example)

## roles 

- Contract Manager - The account that deployed the contract.
  • Deployment & Access: Controls how and when smart contract code is pushed to a blockchain network and who holds permissions to run or modify it.
  • Lifecycle & Versioning: Tracks upgrades and changes to the shared business logic encoded in the contracts as networks evolve.
  • Auditing & Debugging: Monitors transactions running through the code in real time to trace errors, verify performance, and audit execution history.

- Co signer - The accounts that are cosigners of the deployed contract.
  • Permissioned Authority: Validates and authorizes sensitive operations—like minting, pausing, unpausing, emergencyWithdraw, adminReallocate, rotateSigner, which cannot be executed by a single party.
  • Operational Reliability: Maintains continuity by acting as backup or substitute when the primary contract manager is unavailable.
  • Security & Trust: Provides distributed oversight to prevent unilateral control and enforce shared governance rules.

- Standard User - Any account that is not the Contract Manager or a cosigner.
  • Transactional Interaction: Executes standard fungible token operations such as transfers, approvals, and balance queries.
  • Wallet Integration: Connects personal wallets (e.g., Lace, 1AM) to securely sign and broadcast transactions without exposing private keys.
  • Read-Only Information: Accesses public state data like total supply and individual account balances for transparency and verification.

## Constrainsts 

- The frontend must be built with performance in mind.
- The frontend must be built with security in mind.
- The frontend must be built with accessibility in mind.
- The frontend must be built with SEO in mind.
- The frontend must be built with internationalization in mind.
- The frontend must be built with testing in mind.
- The frontend must use clean architecture.
- The frontend must use TypeScript.
- The cosigners must use to sign transactions and ZK proofs off-chain using the offline signer-tools.  
- Midnight transactions  must be persistent 


## Phases 1 - Wallet and Deployment 

1- Implement the connection 
    - to both Lace and 1AM wallets.
    - The connection methods must be reusable by other projects 
    - Add functionallity to disconnect wallet.

2- Implement the compile, test , sdk generation,test sdk,  and deployment interface using midnight.config.json file
    - Implement the interface to compile the contract.
    - Implement the interface to generate the sdk.
    - Implement the interface to generate tests.
    - Implement the interface to run the tests and show the results.
    - Implement the interface to deploy the contract.


## Phase 2 -  Functions 

3- Implement the UI to interact with the deployed smart contract. UI must be split between the three roles of the users. 
    - The role of Contract Manager is the account that deployed the contract.
    - The role of cosigner is the account that is a cosigner of the deployed contract.
    - The standard user is any account that is not the Contract Manager or a cosigner.
    -  Each role must have their own set of  functions that they can access.

    - Implement the interface to mint the token.
    - Implement the interface to transfer the token.
    - Implement the interface to transferFrom the token.
    - Implement the interface to approve the allownace
    - Implement the interface to burn the token.
    - Implement the interface to pause the contract.
    - Implement the interface to unpause the contract.
    - Implement the interface to query the balances of the token for an account.
    - Implement the interface to query the allowances of the token for an account.
    - Implement the interface to query the total supply of the token.
    - Implement the interface to check the approval status of the token for an account.
    - Implement the interface to setEmergencyPauser.
    - Implement the interface to  adminReallocate.
    - Implement the interface to rotateSigner.
    - Implement the interface to emergencyWithdraw.
 

Specifically:
1. Support all contract circuits:
2. Handle the  complexities of contract authentication pattern (`authenticate(account)`):
3. Handle the  complexities of preserving Multi-Sig State (OpenZeppelin Pattern)
4. Support both **Test Mode** (local simulator / mock identities) and **Wallet Mode** (live on-chain using **Lace and 1AM Wallets**).

---

## ⚙️ Network  Configuration

- **Network ID**: `preprod`
- **Indexer GraphQL Endpoint**: `https://indexer.preprod.midnight.network/api/v4/graphql`
- **Indexer WebSocket Endpoint**: `wss://indexer.preprod.midnight.network/api/v4/graphql/ws`
- **Node RPC Endpoint**: `https://rpc.preprod.midnight.network`
- **Proof Server Endpoint**: `http://127.0.0.1:6300`
- **Faucet Endpoint**: `https://faucet.preprod.midnight.network`
- **Block Explorer**: `https://explorer.1am.xyz`

---

## 📋 Step-by-Step Implementation Roadmap

1- Implement the phase 1 
- UI plolish ( -midnight-theme ) 
- Make the UI be , user friendly  and responsive to different screen sizes  
- Midnight tooling (midnight-sdk , midnight-runtime , midnight-dapp-connector , midnight-wallet ) 
- Verify the test suite with `npm test` and production build with `npm run build`

2- Implement the phase 2 

    
