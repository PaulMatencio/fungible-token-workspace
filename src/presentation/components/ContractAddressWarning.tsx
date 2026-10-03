'use client';
import { useEffect, useState } from 'react';
import { networkConfig } from '@/infrastructure/config/network';
import { walletAddressToHex } from '@/infrastructure/wallet/address';
import { useApp } from '../providers/AppProvider';
import { Alert } from './ui';

/** Live warning under a wallet-address input: the token contract's own address is not a wallet (tokens sent there are lost). */
export function ContractAddressWarning({ value }: { value: string }) {
  const { state } = useApp();
  const [hit, setHit] = useState(false);
  useEffect(() => {
    let live = true;
    const v = value.trim();
    if (!state || !v) { setHit(false); return; }
    walletAddressToHex(v, networkConfig.networkId)
      .then((hex) => { if (live) setHit(hex === state.contractAddress.toLowerCase()); })
      .catch(() => { if (live) setHit(false); });
    return () => { live = false; };
  }, [value, state]);
  if (!hit) return null;
  return (
    <div className="mt-2">
      <Alert tone="bad">
        <b>This is the token contract’s own address, not a wallet.</b> Tokens sent here are lost forever — nobody holds its key.
        To put tokens into the contract, send them to your own wallet and use “Deposit to the contract”.
      </Alert>
    </div>
  );
}
