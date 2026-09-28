'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppKitAccount } from '@reown/appkit/react';
import { parseUnits, type Address } from 'viem';
import { usePublicClient, useReadContract, useSignMessage, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
// import { AdminSiteControlPanel } from '@/components/features/admin-control/AdminSiteControlPanel';
import type { ContentMode } from '@/components/features/admin-control/types';
import { AdminHeader } from '@/components/layout/AdminHeader';
import { FundsActionModal } from '@/components/features/roi/FundsActionModal';
import { OwnerVaultActionsPanel } from '@/components/features/roi/OwnerVaultActionsPanel';
import { PrincipalWithdrawPanel } from '@/components/features/roi/PrincipalWithdrawPanel';
import { RoiPerformancePanel } from '@/components/features/roi/RoiPerformancePanel';
import { useOwnerVaultActions } from '@/components/features/roi/useOwnerVaultActions';
import { ensureAppKit } from '@/lib/appkit';
import type {
  ActionState,
  CurrentCycle,
  FundsModalType,
  RoiHistoryItem,
  RoiHistoryRow,
} from '@/components/features/roi/types';
import { normalizeTokenSymbol } from '@/components/features/roi/utils';
import { isApprovedAdminWallet } from '@/lib/admin';
import { fetchCurrentRoi, RoiApiRequestError, updateRoi, type RoiStatus } from '@/lib/roi-api';
import { createRoiUpdateRequest } from '@/lib/roi-auth';
import {
  ERC20_ABI,
  PRINCIPAL_WITHDRAW_TOGGLED_EVENT,
  USDT_CONTRACT_ADDRESS,
  VAULT_CONTRACT_ADDRESS,
  VAULT_ROI_ABI,
} from '@/lib/contracts/vault';
import { APP_CHAIN_ID, appChainLabel, VAULT_DEPLOY_BLOCK } from '@/lib/network';
import { formatTxError } from '@/lib/utils';

ensureAppKit();

const LOG_WINDOW = BigInt(10_000);
const MAX_LOG_WINDOWS = 30;

function statusToContentMode(status: RoiStatus): ContentMode {
  return status === 'auto' ? 'live' : 'manual';
}

export function RoiScreen() {
  const router = useRouter();
  const { isConnected, status, address } = useAppKitAccount();
  const [hasMounted, setHasMounted] = useState(false);
  const [amountInput, setAmountInput] = useState('');
  const [fundsModalType, setFundsModalType] = useState<FundsModalType>(null);
  const [principalActionState, setPrincipalActionState] = useState<ActionState | null>(null);
  const [lastPrincipalChangeAt, setLastPrincipalChangeAt] = useState<string | null>(null);
  const [contentMode, setContentMode] = useState<ContentMode>('manual');
  const [manualRoi, setManualRoi] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [roiUpdatedAt, setRoiUpdatedAt] = useState<string | null>(null);
  const [isRoiLoading, setIsRoiLoading] = useState(true);
  const [isRoiSaving, setIsRoiSaving] = useState(false);
  const [roiActionState, setRoiActionState] = useState<ActionState | null>(null);
  const [modeActionState, setModeActionState] = useState<ActionState | null>(null);
  const [roiLoadError, setRoiLoadError] = useState<string | null>(null);
  const isApprovedWallet = isApprovedAdminWallet(address);
  const { signMessageAsync } = useSignMessage();
  const vaultAddress = VAULT_CONTRACT_ADDRESS;
  const publicClient = usePublicClient({ chainId: APP_CHAIN_ID });
  const vaultQuery = { enabled: Boolean(vaultAddress) };

  const { data: basisPointsRaw } = useReadContract({
    address: vaultAddress,
    abi: VAULT_ROI_ABI,
    functionName: 'BASIS_POINTS',
    chainId: APP_CHAIN_ID,
    query: vaultQuery,
  });

  const {
    data: currentCycleRaw,
    isLoading: isCurrentCycleLoading,
    refetch: refetchCurrentCycle,
  } = useReadContract({
    address: vaultAddress,
    abi: VAULT_ROI_ABI,
    functionName: 'getCurrentCycle',
    chainId: APP_CHAIN_ID,
    query: vaultQuery,
  });

  const {
    data: historyRaw,
    isLoading: isHistoryLoading,
    refetch: refetchHistory,
  } = useReadContract({
    address: vaultAddress,
    abi: VAULT_ROI_ABI,
    functionName: 'getROIHistory',
    chainId: APP_CHAIN_ID,
    query: vaultQuery,
  });

  const { data: ownerRaw, isLoading: isOwnerLoading } = useReadContract({
    address: vaultAddress,
    abi: VAULT_ROI_ABI,
    functionName: 'owner',
    chainId: APP_CHAIN_ID,
    query: vaultQuery,
  });

  const { data: vaultTokenRaw } = useReadContract({
    address: vaultAddress,
    abi: VAULT_ROI_ABI,
    functionName: 'USDT',
    chainId: APP_CHAIN_ID,
    query: vaultQuery,
  });

  const {
    data: principalWithdrawEnabledRaw,
    isLoading: isPrincipalWithdrawLoading,
    refetch: refetchPrincipalWithdrawEnabled,
  } = useReadContract({
    address: vaultAddress,
    abi: VAULT_ROI_ABI,
    functionName: 'principalWithdrawEnabled',
    chainId: APP_CHAIN_ID,
    query: vaultQuery,
  });

  const tokenAddress = (vaultTokenRaw ?? USDT_CONTRACT_ADDRESS) as Address | undefined;
  const tokenReadAddress = (tokenAddress ?? vaultAddress) as Address;

  const { data: tokenDecimalsRaw } = useReadContract({
    address: tokenReadAddress,
    abi: ERC20_ABI,
    functionName: 'decimals',
    chainId: APP_CHAIN_ID,
    query: {
      enabled: Boolean(tokenAddress),
    },
  });

  const { data: tokenSymbolRaw } = useReadContract({
    address: tokenReadAddress,
    abi: ERC20_ABI,
    functionName: 'symbol',
    chainId: APP_CHAIN_ID,
    query: {
      enabled: Boolean(tokenAddress),
    },
  });

  const {
    data: ownerTokenBalanceRaw,
    refetch: refetchOwnerTokenBalance,
  } = useReadContract({
    address: tokenReadAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: ownerRaw ? [ownerRaw as Address] : undefined,
    chainId: APP_CHAIN_ID,
    query: {
      enabled: Boolean(tokenAddress && ownerRaw),
    },
  });

  const {
    writeContract: writePrincipalWithdrawContract,
    data: principalWithdrawTxHash,
    isPending: isSubmittingPrincipalWithdraw,
    error: principalWithdrawWriteError,
  } = useWriteContract();

  const {
    isLoading: isConfirmingPrincipalWithdraw,
    isSuccess: isPrincipalWithdrawConfirmed,
    error: principalWithdrawReceiptError,
  } = useWaitForTransactionReceipt({
    hash: principalWithdrawTxHash,
  });

  const historyRows = useMemo(() => (historyRaw ?? []) as readonly RoiHistoryItem[], [historyRaw]);
  const effectiveBasisPoints = basisPointsRaw && basisPointsRaw > BigInt(0) ? basisPointsRaw : BigInt(10000);
  const currentCycle = currentCycleRaw as CurrentCycle | undefined;
  const latestHistoryItem = historyRows.at(-1);
  const ownerAddress = ownerRaw as Address | undefined;
  const ownerTokenBalance = ownerTokenBalanceRaw as bigint | undefined;
  const principalWithdrawEnabled = principalWithdrawEnabledRaw as boolean | undefined;
  const tokenDecimals = typeof tokenDecimalsRaw === 'number' ? tokenDecimalsRaw : 6;
  const tokenSymbol = typeof tokenSymbolRaw === 'string' && tokenSymbolRaw.trim() ? tokenSymbolRaw : undefined;
  const isOwner = Boolean(address && ownerAddress && address.toLowerCase() === ownerAddress.toLowerCase());
  const isUpdatingPrincipalWithdraw = isSubmittingPrincipalWithdraw || isConfirmingPrincipalWithdraw;

  const formatRoiPercent = useCallback(
    (roiUnits: bigint) => {
      const value = (Number(roiUnits) * 100) / Number(effectiveBasisPoints);
      return value.toFixed(2);
    },
    [effectiveBasisPoints],
  );

  const parsedAmount = useMemo(() => {
    if (!amountInput.trim()) {
      return null;
    }

    try {
      const amount = parseUnits(amountInput, tokenDecimals);
      return amount > BigInt(0) ? amount : null;
    } catch {
      return null;
    }
  }, [amountInput, tokenDecimals]);

  const currentRoiUnits = currentCycle && currentCycle.roiBps > BigInt(0)
    ? currentCycle.roiBps
    : latestHistoryItem?.roi ?? BigInt(0);
  const currentRoi = formatRoiPercent(currentRoiUnits);
  const currentRoiLabel = currentCycle && currentCycle.roiBps > BigInt(0)
    ? currentCycle.settled
      ? `Cycle #${currentCycle.cycleId.toString()} settled ROI`
      : `Cycle #${currentCycle.cycleId.toString()} live ROI snapshot`
    : latestHistoryItem
      ? 'Latest settled ROI from vault history'
      : 'No settled ROI available yet';
  const manualRoiLabel = 'Manually set Current ROI';

  const resolveAutoRoiNumber = useCallback((): number => {
    if (currentRoi !== '--') {
      const value = Number(currentRoi);
      if (!Number.isNaN(value)) {
        return value;
      }
    }

    return 0;
  }, [currentRoi]);

  const handleUpdateRoi = useCallback(
    async (roi: number, status: RoiStatus, kind: 'mode' | 'roi') => {
      const setActionState = kind === 'mode' ? setModeActionState : setRoiActionState;

      if (!address) {
        const message = 'Connect your wallet to continue.';
        setActionState({ type: 'error', message });
        throw new Error(message);
      }

      setIsRoiSaving(true);
      setActionState({ type: 'info', message: 'Confirm the signature in your wallet...' });

      try {
        const payload = await createRoiUpdateRequest({
          address,
          roi,
          status,
          signMessage: async (message) => signMessageAsync({ message }),
        });

        setActionState({
          type: 'info',
          message: kind === 'mode' ? 'Updating content mode...' : 'Saving ROI...',
        });
        const result = await updateRoi(payload);

        if (result.status === 'manual') {
          setManualRoi(result.roi.toFixed(2));
        }
        setContentMode(statusToContentMode(result.status));
        setRoiUpdatedAt(result.dateTime);
        setRoiLoadError(null);
        setActionState({
          type: 'success',
          message: kind === 'mode'
            ? `Content mode set to ${result.status === 'auto' ? 'Auto' : 'Manual'}.`
            : 'ROI updated successfully.',
        });
      } catch (error) {
        const fallback = kind === 'mode'
          ? 'Unable to update content mode.'
          : 'Unable to save ROI.';
        const message = error instanceof RoiApiRequestError
          ? error.message
          : formatTxError(error, fallback);
        setActionState({ type: 'error', message });
        throw error;
      } finally {
        setIsRoiSaving(false);
      }
    },
    [address, signMessageAsync],
  );


  const handleSaveRoiControl = useCallback(
    async (payload: { mode: ContentMode; roi: string }) => {
      if (payload.mode === 'manual') {
        await handleUpdateRoi(Number(payload.roi), 'manual', 'roi');
        return;
      }

      const payloadRoi = Number(payload.roi);
      const roi = payload.roi !== '--' && !Number.isNaN(payloadRoi)
        ? payloadRoi
        : resolveAutoRoiNumber();
      await handleUpdateRoi(roi, 'auto', 'mode');
    },
    [handleUpdateRoi, resolveAutoRoiNumber],
  );
  const principalWithdrawStatusLabel = isPrincipalWithdrawLoading
    ? '--'
    : principalWithdrawEnabled
      ? 'Enabled'
      : 'Disabled';
  const displayTokenSymbol = normalizeTokenSymbol(tokenSymbol);

  const refreshAfterFunds = useCallback(() => {
    refetchCurrentCycle();
    refetchHistory();
    refetchOwnerTokenBalance();
  }, [refetchCurrentCycle, refetchHistory, refetchOwnerTokenBalance]);

  const {
    breakdown,
    refetchBreakdown,
    runAction,
    pendingAction,
    actionState: fundsActionState,
    setActionState: setFundsActionState,
  } = useOwnerVaultActions({
    account: address as Address | undefined,
    vaultAddress,
    tokenAddress,
    tokenSymbol: displayTokenSymbol,
    onConfirmed: refreshAfterFunds,
  });
  const isUpdatingFunds = pendingAction !== null;
  const cycleOpenedAt = breakdown.deployedPrincipal && currentCycle && !currentCycle.settled
    ? currentCycle.withdrawTime
    : undefined;

  const loadLastPrincipalChangeAt = useCallback(async () => {
    if (!publicClient || !vaultAddress) {
      return;
    }

    try {
      // RPC providers cap log ranges, so search backwards in windows instead of from block 0.
      const latest = await publicClient.getBlockNumber();
      const span = LOG_WINDOW * BigInt(MAX_LOG_WINDOWS);
      const floor = VAULT_DEPLOY_BLOCK ?? (latest > span ? latest - span : BigInt(0));
      let toBlock = latest;

      for (let i = 0; i < MAX_LOG_WINDOWS && toBlock >= floor; i++) {
        const fromBlock = toBlock - floor >= LOG_WINDOW ? toBlock - LOG_WINDOW + BigInt(1) : floor;
        const logs = await publicClient.getLogs({
          address: vaultAddress,
          event: PRINCIPAL_WITHDRAW_TOGGLED_EVENT,
          fromBlock,
          toBlock,
        });
        const latestLog = logs.at(-1);

        if (latestLog?.blockNumber) {
          const block = await publicClient.getBlock({ blockNumber: latestLog.blockNumber });
          setLastPrincipalChangeAt(new Date(Number(block.timestamp) * 1000).toLocaleString());
          return;
        }
        if (fromBlock === floor) break;
        toBlock = fromBlock - BigInt(1);
      }

      setLastPrincipalChangeAt(null);
    } catch {
      setLastPrincipalChangeAt(null);
    }
  }, [publicClient, vaultAddress]);

  const roiHistory = useMemo<RoiHistoryRow[]>(
    () =>
      [...historyRows].reverse().map((row, index) => ({
        id: `${row.timestamp.toString()}-${row.roi.toString()}-${index}`,
        date: new Date(Number(row.timestamp) * 1000).toLocaleString(),
        roiPct: formatRoiPercent(row.roi),
      })),
    [formatRoiPercent, historyRows],
  );

  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    if (!hasMounted || !isApprovedWallet) {
      return;
    }

    let cancelled = false;

    const loadCurrentRoi = async () => {
      setIsRoiLoading(true);
      setRoiLoadError(null);

      try {
        const result = await fetchCurrentRoi();

        if (cancelled) {
          return;
        }

        if (result) {
          setContentMode(statusToContentMode(result.status));
          setRoiUpdatedAt(result.dateTime);
          if (result.status === 'manual') {
            setManualRoi(result.roi.toFixed(2));
          }
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message = error instanceof RoiApiRequestError
          ? error.message
          : formatTxError(error, 'Failed to load current ROI setting.');
        setRoiLoadError(message);
      } finally {
        if (!cancelled) {
          setIsRoiLoading(false);
        }
      }
    };

    void loadCurrentRoi();

    return () => {
      cancelled = true;
    };
  }, [hasMounted, isApprovedWallet]);

  useEffect(() => {
    if (!hasMounted) {
      return;
    }

    if (status === 'disconnected' || (isConnected && !isApprovedWallet)) {
      router.replace('/');
    }
  }, [hasMounted, isApprovedWallet, isConnected, router, status]);

  useEffect(() => {
    loadLastPrincipalChangeAt();
  }, [loadLastPrincipalChangeAt]);

  useEffect(() => {
    if (!isPrincipalWithdrawConfirmed) {
      return;
    }

    refetchPrincipalWithdrawEnabled();
    loadLastPrincipalChangeAt();
    setPrincipalActionState({
      type: 'success',
      message: 'Principal withdraw setting updated successfully.',
    });
  }, [isPrincipalWithdrawConfirmed, loadLastPrincipalChangeAt, refetchPrincipalWithdrawEnabled]);

  useEffect(() => {
    if (principalWithdrawWriteError) {
      setPrincipalActionState({
        type: 'error',
        message: formatTxError(principalWithdrawWriteError, 'Toggle update failed. Please try again.'),
      });
    } else if (principalWithdrawReceiptError) {
      setPrincipalActionState({
        type: 'error',
        message: formatTxError(principalWithdrawReceiptError, 'Toggle update failed. Please try again.'),
      });
    }
  }, [principalWithdrawReceiptError, principalWithdrawWriteError]);

  useEffect(() => {
    if (!fundsActionState || fundsActionState.type === 'info') {
      return;
    }

    const timer = window.setTimeout(() => {
      setFundsActionState(null);
    }, 3000);

    return () => window.clearTimeout(timer);
  }, [fundsActionState, setFundsActionState]);

  useEffect(() => {
    if (!principalActionState || principalActionState.type === 'info') {
      return;
    }

    const timer = window.setTimeout(() => {
      setPrincipalActionState(null);
    }, 3000);

    return () => window.clearTimeout(timer);
  }, [principalActionState]);

  useEffect(() => {
    if (!roiActionState || roiActionState.type === 'info') {
      return;
    }

    const timer = window.setTimeout(() => {
      setRoiActionState(null);
    }, 3000);

    return () => window.clearTimeout(timer);
  }, [roiActionState]);

  useEffect(() => {
    if (!modeActionState || modeActionState.type === 'info') {
      return;
    }

    const timer = window.setTimeout(() => {
      setModeActionState(null);
    }, 3000);

    return () => window.clearTimeout(timer);
  }, [modeActionState]);

  const handleConfirmFunds = async () => {
    if (!fundsModalType) {
      return;
    }

    if (!isOwner) {
      setFundsActionState({ type: 'error', message: 'Only the vault owner can move funds.' });
      return;
    }

    if (!vaultAddress) {
      setFundsActionState({ type: 'error', message: `Vault contract address is not configured for ${appChainLabel}.` });
      return;
    }

    // Closing with a loss may return 0; every other action needs a positive amount.
    const amount = parsedAmount ?? BigInt(0);
    const confirmed = await runAction(fundsModalType, amount);
    if (confirmed) {
      setFundsModalType(null);
      setAmountInput('');
    }
  };

  const handleTogglePrincipalWithdraw = () => {
    if (!isOwner) {
      setPrincipalActionState({ type: 'error', message: 'Only the vault owner can change this setting.' });
      return;
    }

    if (!vaultAddress) {
      setPrincipalActionState({ type: 'error', message: `Vault contract address is not configured for ${appChainLabel}.` });
      return;
    }

    setPrincipalActionState({ type: 'info', message: 'Submitting transaction...' });

    writePrincipalWithdrawContract({
      address: vaultAddress,
      abi: VAULT_ROI_ABI,
      functionName: 'togglePrincipalWithdraw',
      chainId: APP_CHAIN_ID,
    });
  };

  const handleAmountChange = (value: string) => {
    if (value === '' || /^\d*\.?\d*$/.test(value)) {
      setAmountInput(value);
    }
  };

  const openFundsModal = (type: Exclude<FundsModalType, null>) => {
    setFundsActionState(null);
    setAmountInput('');
    setFundsModalType(type);
    // Maxima (e.g. what can be withdrawn) change as users deposit; read them fresh.
    void refetchBreakdown();
    void refetchOwnerTokenBalance();
  };

  const closeFundsModal = () => {
    if (isUpdatingFunds) {
      return;
    }

    setFundsModalType(null);
    setAmountInput('');
  };

  if (!hasMounted || status === 'connecting' || status === 'reconnecting') {
    return (
      <main className="flex min-h-screen items-center justify-center px-6 text-white/70">
        Restoring wallet session...
      </main>
    );
  }

  if (!isConnected || !isApprovedWallet) {
    return null;
  }

  return (
    <div className="min-h-screen h-full">
      <AdminHeader />
      <main className="container py-8 sm:py-10 my-14! sm:my-18! lg:my-22! xl:my-26! 2xl:my-30!">
        {!vaultAddress ? (
          <div className="mb-5 rounded-2xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-100/90">
            Vault contract is not configured for {appChainLabel}. Set NEXT_PUBLIC_VAULT_CONTRACT_ADDRESS.
          </div>
        ) : null}

        {roiLoadError ? (
          <div className="mb-5 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100/90">
            {roiLoadError}
          </div>
        ) : null}

        <PrincipalWithdrawPanel
          principalWithdrawEnabled={principalWithdrawEnabled}
          principalWithdrawStatusLabel={principalWithdrawStatusLabel}
          lastPrincipalChangeAt={lastPrincipalChangeAt}
          isOwnerLoading={isOwnerLoading}
          isOwner={isOwner}
          isPrincipalWithdrawLoading={isPrincipalWithdrawLoading}
          isUpdatingPrincipalWithdraw={isUpdatingPrincipalWithdraw}
          principalActionState={principalActionState}
          onToggle={handleTogglePrincipalWithdraw}
        />

        <div className="grid gap-5 lg:grid-cols-[420px_minmax(0,1fr)] lg:items-stretch">
          <div className="flex w-full flex-col gap-5">
            {/* <AdminSiteControlPanel
              contentMode={contentMode}
              isSaving={isRoiSaving}
              saveState={modeActionState}
            /> */}

            <OwnerVaultActionsPanel
              breakdown={breakdown}
              ownerTokenBalance={ownerTokenBalance}
              cycleOpenedAt={cycleOpenedAt}
              tokenDecimals={tokenDecimals}
              displayTokenSymbol={displayTokenSymbol}
              isOwnerLoading={isOwnerLoading}
              isOwner={isOwner}
              isBusy={isUpdatingFunds}
              fundsActionState={fundsModalType ? null : fundsActionState}
              onOpen={openFundsModal}
            />
          </div>

          <div className="min-h-0 h-full">
            <RoiPerformancePanel
              currentRoi={currentRoi}
              currentRoiLabel={currentRoiLabel}
              isCurrentCycleLoading={isCurrentCycleLoading || isRoiLoading}
              isHistoryLoading={isHistoryLoading}
              roiHistory={roiHistory}
              contentMode={contentMode}
              manualRoi={manualRoi}
              manualRoiLabel={manualRoiLabel}
              isSaving={isRoiSaving}
              saveState={roiActionState ?? modeActionState}
              onSaveRoiControl={handleSaveRoiControl}
            />
          </div>
        </div>
      </main>

      <FundsActionModal
        action={fundsModalType}
        breakdown={breakdown}
        ownerTokenBalance={ownerTokenBalance}
        tokenDecimals={tokenDecimals}
        displayTokenSymbol={displayTokenSymbol}
        principalWithdrawEnabled={principalWithdrawEnabled}
        amountInput={amountInput}
        parsedAmount={parsedAmount}
        actionState={fundsActionState}
        isSubmitting={isUpdatingFunds}
        onAmountChange={handleAmountChange}
        onClose={closeFundsModal}
        onConfirm={() => void handleConfirmFunds()}
      />
    </div>
  );
}
