'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Coins } from 'lucide-react';
import { formatUnits } from 'viem';
import { Button } from '@/components/common/Button';
import { ActionStatus } from '@/components/features/roi/ActionStatus';
import { formatTokenAmount } from '@/components/features/roi/utils';
import type { ActionState, FundsModalType, VaultBreakdown } from '@/components/features/roi/types';

type FundsActionModalProps = {
  action: FundsModalType;
  breakdown: VaultBreakdown;
  ownerTokenBalance?: bigint;
  tokenDecimals: number;
  displayTokenSymbol: string;
  principalWithdrawEnabled?: boolean;
  amountInput: string;
  parsedAmount: bigint | null;
  actionState: ActionState | null;
  isSubmitting: boolean;
  onAmountChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
};

const ZERO = BigInt(0);

function percentOf(part: bigint, whole?: bigint) {
  if (!whole || whole === ZERO) return '--';
  return ((Number(part) * 100) / Number(whole)).toFixed(2);
}

export function FundsActionModal({
  action,
  breakdown,
  ownerTokenBalance,
  tokenDecimals,
  displayTokenSymbol,
  principalWithdrawEnabled,
  amountInput,
  parsedAmount,
  actionState,
  isSubmitting,
  onAmountChange,
  onClose,
  onConfirm,
}: FundsActionModalProps) {
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the confirmation each time the modal opens
    setAcknowledged(false);
  }, [action]);

  if (!action) {
    return null;
  }

  const fmt = (value?: bigint) => (value !== undefined ? formatTokenAmount(value, tokenDecimals) : '--');
  const amount = parsedAmount ?? ZERO;
  const active = breakdown.activePrincipal;
  const deployed = breakdown.deployedPrincipal ?? ZERO;
  const pending = breakdown.pendingPrincipal ?? ZERO;
  const withdrawable = breakdown.ownerWithdrawable ?? ZERO;
  const cycleOpen = deployed > ZERO;
  const setMax = (value: bigint) => onAmountChange(formatUnits(value, tokenDecimals));

  // Returning 0 is allowed only when closing with a loss (nothing could be recovered).
  const needsAmount = action !== 'loss';

  let title = '';
  let subtitle = '';
  let icon = <Coins size={18} />;
  let rows: { label: string; value: string }[] = [];
  let maxLabel: string | null = null;
  let maxValue = ZERO;
  const notes: string[] = [];
  let warning: string | null = null;
  let acknowledgement: string | null = null;
  let error: string | null = null;
  let confirmLabel = '';

  if (action === 'profit') {
    title = 'Distribute Profit';
    subtitle = 'Send only the profit. It is shared by everyone in the pool by the size of their principal, and users can claim it right away.';
    icon = <Coins size={18} />;
    rows = [
      { label: 'Pool (earning)', value: fmt(active) },
      { label: 'Your wallet', value: fmt(ownerTokenBalance) },
    ];
    if (amount > ZERO) {
      notes.push(`ROI for this distribution: ${percentOf(amount, active)}% of the pool.`);
    }
    if (pending > ZERO) {
      notes.push(`${fmt(pending)} ${displayTokenSymbol} of waiting deposits won't share this profit; they haven't joined the pool yet.`);
    }
    if (!cycleOpen) {
      warning = 'No cycle is open. Distribute a cycle\'s profit before returning its principal, so it goes to the people whose money earned it.';
    }
    if (!active || active === ZERO) {
      error = 'Nobody is in the pool, so there is no one to distribute profit to.';
    }
    confirmLabel = 'Distribute Profit';
  } else if (action === 'return') {
    title = 'Return Principal';
    subtitle = 'Bring principal back to the vault. When everything you took out is back, the cycle closes.';
    icon = <ArrowDownLeft size={18} />;
    rows = [
      { label: 'With you (deployed)', value: fmt(deployed) },
      { label: 'Your wallet', value: fmt(ownerTokenBalance) },
    ];
    maxLabel = 'Return all';
    maxValue = deployed;
    if (amount > deployed) {
      error = 'That is more than you took out. Send profit with Distribute Profit instead.';
    }
    if (amount > ZERO && amount === deployed) {
      notes.push('This closes the cycle. Users whose deposits have been through a cycle can then withdraw their principal.');
      if (principalWithdrawEnabled === false) {
        warning = 'Principal withdrawals are switched OFF, so users won\'t be able to leave in this window. Turn them on if you want to open a withdrawal window.';
      }
      acknowledgement = 'I have already distributed this cycle\'s profit.';
    }
    confirmLabel = 'Return Principal';
  } else if (action === 'loss') {
    title = 'Close Cycle With a Loss';
    subtitle = 'Use this only when you cannot return everything you took out. Enter what you can return (0 is allowed).';
    icon = <AlertTriangle size={18} />;
    const loss = deployed > amount ? deployed - amount : ZERO;
    rows = [
      { label: 'With you (deployed)', value: fmt(deployed) },
      { label: 'Pool (earning)', value: fmt(active) },
      { label: 'Loss written off', value: fmt(loss) },
    ];
    if (amount >= deployed && deployed > ZERO) {
      error = 'You are returning everything, so there is no loss. Use Return Principal instead.';
    } else if (active !== undefined && loss >= active) {
      error = 'The loss would wipe out the whole pool. Return at least a small amount.';
    } else {
      warning = `Every deposit in the pool permanently loses ${percentOf(loss, active)}% of its principal. Profit already earned is not affected.`;
      acknowledgement = 'I understand this loss is permanent and shared by every deposit in the pool.';
    }
    confirmLabel = 'Close With Loss';
  } else {
    title = 'Withdraw to Trade';
    subtitle = 'Take principal out of the vault to trade. The funds go to your wallet and principal stays locked until you return it.';
    icon = <ArrowUpRight size={18} />;
    rows = [
      { label: 'Available to withdraw', value: fmt(withdrawable) },
      { label: 'Waiting to join', value: fmt(pending) },
    ];
    maxLabel = 'Max';
    maxValue = withdrawable;
    if (withdrawable === ZERO) {
      error = 'Nothing is available to withdraw right now.';
    } else if (amount > withdrawable) {
      error = 'That is more than is available to withdraw.';
    }
    if (pending > ZERO) {
      notes.push(`${fmt(pending)} ${displayTokenSymbol} of waiting deposits join the pool now and share every distribution from here on. If you owe profit for the current period, distribute it first.`);
    }
    if (!cycleOpen) {
      notes.push('This opens a new cycle.');
      if (principalWithdrawEnabled) {
        warning = 'Tip: switch principal withdrawals off before opening a cycle, so the available amount can\'t change while you sign.';
      }
    }
    confirmLabel = 'Withdraw';
  }

  if (!error && needsAmount && amount > ZERO && action !== 'withdraw' && ownerTokenBalance !== undefined && amount > ownerTokenBalance) {
    error = `Your wallet doesn't hold enough ${displayTokenSymbol}.`;
  }

  const enteredZero = /^0*\.?0*$/.test(amountInput.trim()) && amountInput.trim() !== '';
  const hasAmount = needsAmount ? amount > ZERO : amount > ZERO || enteredZero;
  const canConfirm = hasAmount && !error && (!acknowledgement || acknowledged) && !isSubmitting;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm">
      <div className="panel w-full max-w-md rounded-[28px] border border-white/10 p-6 sm:p-7">
        <div className={`mb-5 flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border ${action === 'loss'
          ? 'border-red-500/30 bg-red-500/10 text-red-300'
          : 'border-primary/20 bg-primary/10 text-primary'
          }`}>
          {icon}
        </div>
        <div className="mb-5 space-y-2">
          <p className="text-xs font-medium uppercase tracking-[0.22em] text-white/38">Owner Vault Action</p>
          <h2 className="text-2xl font-semibold text-white">{title}</h2>
          <p className="text-sm leading-6 text-white/56">{subtitle}</p>
        </div>

        <div className="mb-4 grid gap-2 rounded-[24px] border border-white/8 bg-white/[0.03] p-4">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-white/45">{row.label}</span>
              <span className="font-semibold text-white">{row.value} <span className="text-xs text-white/40">{displayTokenSymbol}</span></span>
            </div>
          ))}
        </div>

        <div className="mb-3 flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.045] px-4 py-4 focus-within:border-primary/40">
          <input
            type="text"
            inputMode="decimal"
            value={amountInput}
            onChange={(event) => onAmountChange(event.target.value)}
            placeholder="0.00"
            disabled={isSubmitting}
            className="w-full min-w-0 bg-transparent text-left text-3xl font-semibold text-white outline-none placeholder:text-white/20"
          />
          {maxLabel && maxValue > ZERO ? (
            <button
              type="button"
              onClick={() => setMax(maxValue)}
              disabled={isSubmitting}
              className="shrink-0 rounded-lg border border-primary/30 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/10"
            >
              {maxLabel}
            </button>
          ) : null}
          <span className="text-sm font-medium uppercase tracking-[0.18em] text-white/45">{displayTokenSymbol}</span>
        </div>

        {notes.map((note) => (
          <p key={note} className="mb-2 text-xs leading-5 text-white/55">{note}</p>
        ))}
        {warning ? (
          <p className="mb-3 rounded-xl border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs leading-5 text-amber-100/90">{warning}</p>
        ) : null}
        {error ? (
          <p className="mb-3 text-xs leading-5 text-red-300/90">{error}</p>
        ) : null}
        {acknowledgement && !error ? (
          <label className="mb-4 flex cursor-pointer items-start gap-2 text-xs leading-5 text-white/70">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              disabled={isSubmitting}
              className="mt-0.5"
            />
            <span>{acknowledgement}</span>
          </label>
        ) : null}

        <ActionStatus state={actionState} className="mb-5" />

        <div className="flex w-full gap-2 sm:gap-3">
          <Button
            title="Cancel"
            variant="ghost"
            className="h-10 min-w-0 flex-1 px-3 text-xs sm:h-12 sm:min-w-28 sm:flex-none sm:px-5 sm:text-sm"
            onClick={onClose}
            disabled={isSubmitting}
          />
          <Button
            title={isSubmitting ? 'Working...' : confirmLabel}
            className={`h-10 min-w-0 flex-1 px-3 text-xs sm:h-12 sm:min-w-36 sm:flex-none sm:px-5 sm:text-sm ${action === 'loss' ? 'bg-red-400 hover:bg-red-300' : ''}`}
            onClick={onConfirm}
            disabled={!canConfirm}
          />
        </div>
      </div>
    </div>
  );
}
