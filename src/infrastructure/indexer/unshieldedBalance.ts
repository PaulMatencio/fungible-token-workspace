/**
 * Unshielded token balance of ANY address, computed from the indexer's UTXO history (no wallet involved):
 * balance = Σ created UTXOs − Σ spent UTXOs of the token color, replayed from the `unshieldedTransactions`
 * subscription. The indexer sends a progress message FIRST and then streams the history, so the replay is complete
 * once the stream has gone quiet (IDLE_MS without a new event) after progress arrived.
 */
import { createClient } from 'graphql-ws';

const SUBSCRIPTION = `subscription($a: UnshieldedAddress!) {
  unshieldedTransactions(address: $a) {
    __typename
    ... on UnshieldedTransaction {
      createdUtxos { tokenType value intentHash outputIndex }
      spentUtxos { tokenType value intentHash outputIndex }
    }
    ... on UnshieldedTransactionsProgress { highestTransactionId }
  }
}`;

const IDLE_MS = 1200;

type Utxo = { tokenType: string; value: string; intentHash: string; outputIndex: number };

export function indexerUnshieldedBalance(wsUrl: string, address: string, colorHex: string, timeoutMs = 20_000): Promise<bigint> {
  const color = colorHex.toLowerCase();
  const live = new Map<string, bigint>(); // utxo id → value (created and not yet seen spent)
  const spent = new Set<string>();
  return new Promise<bigint>((resolve, reject) => {
    const client = createClient({ url: wsUrl, lazy: true, retryAttempts: 0 });
    let dispose = () => {};
    let idle: ReturnType<typeof setTimeout> | undefined;
    let progressed = false;
    const finish = (err?: Error) => {
      clearTimeout(timer);
      clearTimeout(idle);
      dispose();
      void client.dispose();
      if (err) return reject(err);
      let sum = 0n;
      for (const [id, v] of live) if (!spent.has(id)) sum += v;
      resolve(sum);
    };
    const timer = setTimeout(() => finish(new Error('Indexer did not finish the UTXO replay in time')), timeoutMs);
    const id = (u: Utxo) => `${u.intentHash}:${u.outputIndex}`;
    dispose = client.subscribe(
      { query: SUBSCRIPTION, variables: { a: address } },
      {
        next: ({ data, errors }) => {
          if (errors?.length) return finish(new Error(errors[0].message));
          const ev = data?.unshieldedTransactions as
            | { __typename: string; createdUtxos?: Utxo[]; spentUtxos?: Utxo[]; highestTransactionId?: number }
            | undefined;
          if (!ev) return;
          clearTimeout(idle);
          if (ev.__typename === 'UnshieldedTransaction') {
            for (const u of ev.createdUtxos ?? []) if (u.tokenType.toLowerCase() === color) live.set(id(u), BigInt(u.value));
            for (const u of ev.spentUtxos ?? []) if (u.tokenType.toLowerCase() === color) spent.add(id(u));
          } else if (ev.__typename === 'UnshieldedTransactionsProgress') {
            progressed = true;
          }
          if (progressed) idle = setTimeout(() => finish(), IDLE_MS);
        },
        error: (e) => finish(e instanceof Error ? e : new Error(JSON.stringify(e))),
        complete: () => finish()
      }
    );
  });
}
