'use client';
import { useEffect, useState } from 'react';
import { useApp } from '../providers/AppProvider';

/** Token balance of the connected wallet; re-read whenever the contract state refreshes (after every action and every 15 s). */
export function useMyBalance(): { balance: bigint | null; error: boolean } {
  const { tokenService: s, state } = useApp();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!s || !state) return;
    let live = true;
    s.myBalance()
      .then((b) => { if (live) { setBalance(b); setError(false); } })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [s, state]);
  return { balance, error };
}
