'use client';

import { Button } from '@/components/common/Button';
import { ActionStatus } from '@/components/features/roi/ActionStatus';
import type { ActionState } from '@/components/features/roi/types';

type PrincipalWithdrawPanelProps = {
  principalWithdrawEnabled?: boolean;
  principalWithdrawStatusLabel: string;
  lastPrincipalChangeAt: string | null;
  isOwnerLoading: boolean;
  isOwner: boolean;
  isPrincipalWithdrawLoading: boolean;
  isUpdatingPrincipalWithdraw: boolean;
  principalActionState: ActionState | null;
  onToggle: () => void;
};

export function PrincipalWithdrawPanel({
  principalWithdrawEnabled,
  principalWithdrawStatusLabel,
  lastPrincipalChangeAt,
  isOwnerLoading,
  isOwner,
  isPrincipalWithdrawLoading,
  isUpdatingPrincipalWithdraw,
  principalActionState,
  onToggle,
}: PrincipalWithdrawPanelProps) {
  return (
    <section className="panel mb-5 rounded-[24px] px-5 py-4 sm:px-6 sm:py-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <p className="text-xs uppercase tracking-[0.22em] text-white/42">Principal Withdraw</p>
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${principalWithdrawEnabled === true
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-white/12 bg-white/[0.04] text-white/60'
                }`}
            >
              {principalWithdrawStatusLabel}
            </span>
          </div>
          <p className="text-sm text-white/72">Controls whether users can withdraw their deposited principal from the vault.</p>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-white/42">
            <span>Current status: <span className="text-white/72">{principalWithdrawStatusLabel}</span></span>
            <span>Last changed: <span className="text-white/72">{lastPrincipalChangeAt ?? 'Not available'}</span></span>
          </div>
          {!isOwnerLoading && !isOwner ? (
            <p className="text-xs text-amber-300/90">Only the vault owner can change this setting.</p>
          ) : null}
          {!isPrincipalWithdrawLoading && principalWithdrawEnabled === false ? (
            <p className="text-xs text-amber-300/90">
              Principal withdrawals are OFF. Turn them on before returning principal if you want to open a withdrawal window.
            </p>
          ) : null}
        </div>

        <div className="w-full lg:w-auto lg:min-w-[250px]">
          <Button
            title={isPrincipalWithdrawLoading || isOwnerLoading
              ? 'Loading status...'
              : isUpdatingPrincipalWithdraw
                ? 'Updating setting...'
                : principalWithdrawEnabled
                  ? 'Disable Principal Withdraw'
                  : 'Enable Principal Withdraw'}
            variant="ghost"
            className="w-full border-white/16 bg-transparent text-white hover:bg-white/[0.05]"
            onClick={onToggle}
            disabled={isOwnerLoading || isPrincipalWithdrawLoading || !isOwner || isUpdatingPrincipalWithdraw}
          />
          <ActionStatus state={principalActionState} className="mt-3" />
        </div>
      </div>
    </section>
  );
}
