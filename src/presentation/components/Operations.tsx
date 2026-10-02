'use client';
import { useState } from 'react';
import { Coins, Search } from 'lucide-react';
import { formatAmount } from '@/domain/amount';
import { shortHex } from '@/domain/hex';
import { networkConfig } from '@/infrastructure/config/network';
import { walletAddressToHex } from '@/infrastructure/wallet/address';
import { useApp } from '../providers/AppProvider';
import { useT } from '../i18n';
import { ActionForm } from './ActionForm';
import { ActionProgressPanel } from './DeployProgressPanel';
import { MultisigWizard, RequestReview } from './Multisig';
import { Alert, Badge, Card, Field } from './ui';

/** What every wallet owner can do: move the native token wallet → wallet, or deposit into the contract. */
export function WalletOps() {
  const { t } = useT();
  const { tokenService: s, state, gateway } = useApp();
  if (!s || !state) return null;
  return (
    <Card title={t('ops.wallet')} icon={<Coins size={16} aria-hidden />} className="lg:col-span-2">
      <p className="mb-3 text-xs text-slate-400">{t('ops.wallet.hint')}</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <ActionForm id="transfer" title={t('op.transfer')} fields={[
          { name: 'to', label: t('ops.recipientWallet'), mono: true, wallet: true, placeholder: 'mn_addr_preprod1…' },
          { name: 'amount', label: t('ops.amount'), inputMode: 'decimal' }
        ]} onSubmit={(v) => s.transfer(v.to ?? '', v.amount ?? '')} />
        <ActionForm id="deposit" title={t('op.deposit')} disabled={state.paused} fields={[
          { name: 'amount', label: t('ops.amount'), inputMode: 'decimal' }
        ]} onSubmit={(v) => s.deposit(v.amount ?? '')} />
      </div>
      {gateway?.mode === 'wallet' && <p className="mt-3 text-xs text-slate-500">{t('ops.wallet.chainHint')}</p>}
      {state.paused && <div className="mt-3"><Alert tone="warn">{t('ops.paused.native')}</Alert></div>}
    </Card>
  );
}

export function BalancesPanel() {
  const { t } = useT();
  const { tokenService: s, state, mode, walletHex, guard } = useApp();
  const [other, setOther] = useState('');
  const [mine, setMine] = useState<bigint | null>(null);
  const [theirs, setTheirs] = useState<bigint | null>(null);
  if (!s || !state) return null;
  const fmt = (v: bigint) => `${formatAmount(v, state.decimals, { group: true })} ${state.symbol}`;

  return (
    <Card title={t('ops.readOnly')} icon={<Search size={16} aria-hidden />}>
      <div className="mb-3 grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-xl border border-midnight-700 bg-midnight-900/50 p-3"><div className="label">{t('overview.supply')}</div><b className="text-white">{fmt(state.totalSupply)}</b></div>
        <div className="rounded-xl border border-midnight-700 bg-midnight-900/50 p-3"><div className="label">{t('overview.contractHeld')}</div><b className="text-white">{fmt(state.contractBalance)}</b></div>
      </div>
      <div className="mb-4 rounded-xl border border-midnight-700 bg-midnight-900/50 p-3">
        <div className="label">{t('ops.myBalance')}</div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-ghost" onClick={async () => setMine((await guard(() => s.myBalance())) ?? null)}>{t('ops.query')}</button>
          {mine !== null && <Badge tone="accent">{fmt(mine)}</Badge>}
        </div>
        {walletHex && <p className="mt-2 mono text-slate-500" title={walletHex}>{shortHex(walletHex, 14, 10)}</p>}
      </div>
      {mode === 'test' && (
        <div className="rounded-xl border border-midnight-700 bg-midnight-900/50 p-3">
          <Field label={t('ops.balanceOfWallet')} htmlFor="q-wallet">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input id="q-wallet" className="input font-mono text-xs" value={other} onChange={(e) => setOther(e.target.value)} />
              <button type="button" className="btn-ghost" onClick={async () => setTheirs((await guard(async () => s.balanceOf(await walletAddressToHex(other, networkConfig.networkId)))) ?? null)}>{t('ops.query')}</button>
            </div>
          </Field>
          {theirs !== null && <Badge tone="accent">{fmt(theirs)}</Badge>}
        </div>
      )}
      {mode === 'wallet' && <p className="text-xs text-slate-500">{t('ops.walletOnlyOwn')}</p>}
    </Card>
  );
}

export function PauserOps() {
  const { t } = useT();
  const { tokenService: s, state, role, account } = useApp();
  if (!s || !state || !role) return null;
  const isPauser = account === state.emergencyPauser;
  if (!role.isManager && !isPauser) return null;
  return (
    <Card title={t('role.manager')} className="lg:col-span-1">
      <div className="space-y-3">
        <ActionForm id="pause" title={t('op.pause')} danger fields={[]} disabled={state.paused} onSubmit={() => s.pause()} />
        <ActionForm id="unpause" title={t('op.unpause')} fields={[]} disabled={!state.paused} onSubmit={() => s.unpause()} />
        {role.isManager && (
          <ActionForm id="ew" title={t('op.emergencyWithdraw')} danger disabled={!state.paused} fields={[{ name: 'amount', label: t('ops.amount'), inputMode: 'decimal' }]} onSubmit={(v) => s.emergencyWithdraw(v.amount ?? '')} />
        )}
        <p className="text-xs text-slate-500">{t('ops.treasury')}: <span className="mono">{shortHex(state.treasury, 12, 8)}</span></p>
      </div>
    </Card>
  );
}

export function OperationsTab() {
  const { role, state } = useApp();
  const { t } = useT();
  if (!state || !role) return <Card><p className="text-slate-400">{t('overview.empty')}</p></Card>;
  const canGovern = role.isManager || role.isCosigner;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="lg:col-span-2"><ActionProgressPanel /></div>
      <WalletOps />
      <BalancesPanel />
      <PauserOps />
      {canGovern && (
        <div className="lg:col-span-2">
          <MultisigWizard allowed={['mint', 'burn', 'contractWithdraw', 'setEmergencyPauser', 'rotateSigner']} />
        </div>
      )}
      {role.isCosigner && <RequestReview />}
    </div>
  );
}
