/**
 * Full on-chain history of a contract from the indexer's `contractActions` subscription (deploy, maintenance
 * updates, and every circuit call with its entry point). The stream replays from the start and then stays open for
 * new blocks, so the replay is complete once it has been quiet for IDLE_MS.
 */
import { createClient } from 'graphql-ws';

const SUBSCRIPTION = `subscription($a: HexEncoded!) {
  contractActions(address: $a) {
    __typename
    ... on ContractCall { entryPoint }
    transaction { hash block { height timestamp } }
  }
}`;

export interface ChainAction {
  kind: 'deploy' | 'update' | 'call';
  /** Circuit name for calls; 'deploy' / 'maintenance' otherwise. */
  circuit: string;
  txHash: string;
  blockHeight: number;
  /** Block time, ms since epoch. */
  at: number;
}

const IDLE_MS = 1500;
const FIRST_EVENT_MS = 5000;

export function fetchContractHistory(wsUrl: string, address: string, timeoutMs = 30_000): Promise<ChainAction[]> {
  const out: ChainAction[] = [];
  return new Promise<ChainAction[]>((resolve, reject) => {
    const client = createClient({ url: wsUrl, lazy: true, retryAttempts: 0 });
    let dispose = () => {};
    let idle: ReturnType<typeof setTimeout> | undefined;
    const finish = (err?: Error) => {
      clearTimeout(idle);
      clearTimeout(hard);
      dispose();
      void client.dispose();
      if (err) reject(err);
      else resolve(out);
    };
    const hard = setTimeout(() => finish(new Error('Indexer did not finish the history replay in time')), timeoutMs);
    idle = setTimeout(() => finish(), FIRST_EVENT_MS);
    dispose = client.subscribe(
      { query: SUBSCRIPTION, variables: { a: address.toLowerCase() } },
      {
        next: ({ data, errors }) => {
          if (errors?.length) return finish(new Error(errors[0].message));
          const a = data?.contractActions as
            | { __typename: string; entryPoint?: string; transaction: { hash: string; block: { height: number; timestamp: number } } }
            | undefined;
          if (!a) return;
          const kind = a.__typename === 'ContractDeploy' ? 'deploy' : a.__typename === 'ContractCall' ? 'call' : 'update';
          out.push({
            kind,
            circuit: kind === 'call' ? String(a.entryPoint) : kind === 'deploy' ? 'deploy' : 'maintenance',
            txHash: a.transaction.hash,
            blockHeight: a.transaction.block.height,
            at: a.transaction.block.timestamp
          });
          clearTimeout(idle);
          idle = setTimeout(() => finish(), IDLE_MS);
        },
        error: (e) => finish(e instanceof Error ? e : new Error(JSON.stringify(e))),
        complete: () => finish()
      }
    );
  });
}
