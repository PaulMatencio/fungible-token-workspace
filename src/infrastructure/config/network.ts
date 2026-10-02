import raw from '../../../midnight.config.json';

export interface NetworkConfig {
  networkId: string;
  indexer: string;
  indexerWS: string;
  nodeRpc: string;
  proofServer: string;
  faucet: string;
  explorer: string;
}

/** Contract build settings, overridable in midnight.config.json (`contract` block). */
export interface ContractConfig {
  source: string;
  name: string;
  managedDir: string;
  sdkDir: string;
  testsDir: string;
  /** compactc toolchain; must emit the runtime midnight-js expects (0.31.x ↔ runtime 0.16.0). */
  compilerVersion: string;
  /**
   * Circuits whose verifier keys go into the deploy transaction itself. The rest are registered in
   * follow-up maintenance transactions: a deploy carrying all 12 keys (~28 KB) was rejected by preprod
   * with "Transaction would exhaust the block limits".
   */
  deployCircuits: string[];
}

const defaults: ContractConfig = {
  source: 'contract/fungible_token_native_v3.compact',
  name: 'fungible-token-native-v3',
  managedDir: 'contract/managed/fungible-token-native-v3',
  sdkDir: 'sdk/fungible-token-native-v3',
  testsDir: 'tests/generated',
  compilerVersion: '0.31.1',
  deployCircuits: ['mint', 'deposit', 'pause', 'unpause']
};

export const networkConfig: NetworkConfig = raw as NetworkConfig;
export const contractConfig: ContractConfig = { ...defaults, ...((raw as { contract?: Partial<ContractConfig> }).contract ?? {}) };

export const explorerTxUrl = (hash: string) => `${networkConfig.explorer}/tx/${hash}`;
export const explorerContractUrl = (addr: string) => `${networkConfig.explorer}/contract/${addr}`;
