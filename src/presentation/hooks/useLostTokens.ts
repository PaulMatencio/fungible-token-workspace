'use client';
import { useEffect, useState } from 'react';
import { useApp } from '../providers/AppProvider';

/** Burnt and misdirected (sent to the contract's own address) amounts; re-read whenever the contract state refreshes. */
export function useLostTokens(): { burned: bigint; atContractAddress: bigint } | 'error' | null {
  const { tokenService: s, state } = useApp();
  const [v, setV] = useState<{ burned: bigint; atContractAddress: bigint } | 'error' | null>(null);
  useEffect(() => {
    if (!s || !state) return;
    let live = true;
    s.lostTokens().then((r) => live && setV(r)).catch(() => live && setV('error'));
    return () => { live = false; };
  }, [s, state]);
  return v;
}
