'use client';

import { Wallet } from 'lucide-react';
import { Button } from '@/components/common/Button';
import { ActionStatus } from '@/components/features/roi/ActionStatus';
import { formatTokenAmount } from '@/components/features/roi/utils';
import type { ActionState, OwnerAction, VaultBreakdown } from '@/components/features/roi/types';

type OwnerVaultActionsPanelProps = {
  breakdown: VaultBreakdown;
  ownerTokenBalance?: bigint;
  /** When the open cycle started (unix seconds), if one is open. */
  cycleOpenedAt?: bigint;
  tokenDecimals: number;
  displayTokenSymbol: string;
  isOwnerLoading: boolean;
  isOwner: boolean;
  isBusy: boolean;
  fundsActionState: ActionState | null;
  onOpen: (action: OwnerAction) => void;
};

const ZERO = BigInt(0);

export function OwnerVaultActionsPanel({
  breakdown,
  ownerTokenBalance,
  cycleOpenedAt,
  tokenDecimals,
  displayTokenSymbol,
  isOwnerLoading,
  isOwner,
  isBusy,
  fundsActionState,
  onOpen,
}: OwnerVaultActionsPanelProps) {
  const fmt = (value?: bigint) => (value !== undefined ? formatTokenAmount(value, tokenDecimals) : '--');
  const deployed = breakdown.deployedPrincipal ?? ZERO;
  const cycleOpen = deployed > ZERO;
  const cards = [
    { label: 'Pool (earning)', value: breakdown.activePrincipal, hint: 'Principal of everyone in the pool' },
    { label: 'With you', value: breakdown.deployedPrincipal, hint: 'Must be returned before users can withdraw principal' },
    { label: 'Waiting to join', value: breakdown.pendingPrincipal, hint: 'Joins the pool at your next withdraw' },
    { label: 'Unclaimed user profit', value: breakdown.profitReserve, hint: 'Reserved for users; you can\'t withdraw it' },
  ];
  const disabled = !isOwner || isBusy;

  return (
    <section className="panel w-full rounded-[24px] p-6 sm:p-7">
      <div className="flex h-full flex-col">
        <div className="space-y-4 border-b border-white/8 pb-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
              <Wallet size={18} />
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-white/42">Owner Vault Actions</p>
              <p className="mt-1 text-sm text-white/56">
                {cycleOpen
                  ? `Cycle open since ${cycleOpenedAt ? new Date(Number(cycleOpenedAt) * 1000).toLocaleString() : '--'}. Principal is locked.`
                  : 'No cycle open. Users whose deposits have been through a cycle can withdraw principal.'}
              </p>
            </div>
          </div>
        </div>

        <div className="pt-5">
          <div className="mb-3 grid grid-cols-2 gap-3 text-sm text-white/72">
            {cards.map((card) => (
              <div
                key={card.label}
                className="rounded-[22px] border border-white/8 bg-gradient-to-br from-white/[0.045] to-white/[0.02] p-4 shadow-[0_12px_40px_rgba(0,0,0,0.18)]"
              >
                <div className="text-[11px] uppercase tracking-[0.18em] text-white/34">{card.label}</div>
                <div className="mt-2 text-xl font-semibold text-white">{fmt(card.value)}</div>
                <div className="mt-1 text-[11px] leading-4 text-white/38">{card.hint}</div>
              </div>
            ))}
          </div>
          <p className="mb-3 text-xs text-white/45">
            Your wallet: <span className="text-white/72">{fmt(ownerTokenBalance)} {displayTokenSymbol}</span>
          </p>

          {!isOwnerLoading && !isOwner ? (
            <p className="mb-2 text-xs text-amber-300/90">Only the vault owner can move funds.</p>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <Button
              title="Distribute Profit"
              className="w-full"
              onClick={() => onOpen('profit')}
              disabled={disabled || !breakdown.activePrincipal}
            />
            <Button
              title="Withdraw to Trade"
              className="w-full"
              onClick={() => onOpen('withdraw')}
              disabled={disabled || !breakdown.ownerWithdrawable}
            />
            <Button
              title="Return Principal"
              variant="ghost"
              className="col-span-2 w-full"
              onClick={() => onOpen('return')}
              disabled={disabled || !cycleOpen}
            />
          </div>
          <button
            type="button"
            onClick={() => onOpen('loss')}
            disabled={disabled || !cycleOpen}
            className="mt-3 text-xs text-red-300/80 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
          >
            Close cycle with a loss...
          </button>
          <ActionStatus state={fundsActionState} className="mt-2" />
        </div>
      </div>
    </section>
  );
}
