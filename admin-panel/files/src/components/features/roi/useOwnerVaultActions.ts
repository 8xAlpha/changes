'use client';

import { useCallback, useState } from 'react';
import type { Address, Hash } from 'viem';
import { usePublicClient, useReadContracts, useWriteContract } from 'wagmi';
import type { ActionState, OwnerAction, VaultBreakdown } from '@/components/features/roi/types';
import { ERC20_ABI, VAULT_ROI_ABI } from '@/lib/contracts/vault';
import { APP_CHAIN_ID } from '@/lib/network';
import { formatTxError } from '@/lib/utils';

const ACTION_FUNCTION = {
  profit: 'distributeProfit',
  return: 'ownerReturnPrincipal',
  loss: 'ownerCloseCycleWithLoss',
  withdraw: 'ownerWithdraw',
} as const;

const SUCCESS_MESSAGE: Record<OwnerAction, string> = {
  profit: 'Profit distributed. Users can claim it now.',
  return: 'Principal returned.',
  loss: 'Cycle closed and the loss recorded.',
  withdraw: 'Principal withdrawn to your wallet.',
};

const FAILURE_MESSAGE: Record<OwnerAction, string> = {
  profit: 'Profit distribution failed. Please try again.',
  return: 'Returning principal failed. Please try again.',
  loss: 'Closing the cycle failed. Please try again.',
  withdraw: 'Withdrawal failed. Please try again.',
};

type UseOwnerVaultActionsParams = {
  account?: Address;
  vaultAddress?: Address;
  tokenAddress?: Address;
  tokenSymbol: string;
  /** Called after any owner action confirms, so the screen can refresh its other reads. */
  onConfirmed?: () => void;
};

/**
 * Reads the vault breakdown and runs owner actions (distribute profit, return principal,
 * close with a loss, withdraw to trade) as one sequence: approve USDT if needed, send the
 * vault call, wait for it to confirm.
 */
export function useOwnerVaultActions({
  account,
  vaultAddress,
  tokenAddress,
  tokenSymbol,
  onConfirmed,
}: UseOwnerVaultActionsParams) {
  const publicClient = usePublicClient({ chainId: APP_CHAIN_ID });
  const { mutateAsync: writeContractAsync } = useWriteContract();
  const [pendingAction, setPendingAction] = useState<OwnerAction | null>(null);
  const [actionState, setActionState] = useState<ActionState | null>(null);

  const vaultRead = { address: vaultAddress as Address, abi: VAULT_ROI_ABI, chainId: APP_CHAIN_ID } as const;
  const {
    data: breakdownRaw,
    isLoading: isBreakdownLoading,
    refetch: refetchBreakdown,
  } = useReadContracts({
    contracts: [
      { ...vaultRead, functionName: 'activePrincipal' },
      { ...vaultRead, functionName: 'deployedPrincipal' },
      { ...vaultRead, functionName: 'pendingPrincipal' },
      { ...vaultRead, functionName: 'profitReserve' },
      { ...vaultRead, functionName: 'ownerWithdrawable' },
    ],
    query: { enabled: Boolean(vaultAddress) },
  });

  const valueAt = (index: number) => {
    const entry = breakdownRaw?.[index];
    return entry?.status === 'success' ? (entry.result as bigint) : undefined;
  };

  const breakdown: VaultBreakdown = {
    activePrincipal: valueAt(0),
    deployedPrincipal: valueAt(1),
    pendingPrincipal: valueAt(2),
    profitReserve: valueAt(3),
    ownerWithdrawable: valueAt(4),
  };

  const waitFor = useCallback(
    async (hash: Hash) => {
      if (!publicClient) throw new Error('No connection to the network.');
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('Transaction reverted.');
    },
    [publicClient],
  );

  /** Mainnet USDT rejects changing one non-zero approval to another, so reset to 0 first. */
  const ensureAllowance = useCallback(
    async (owner: Address, vault: Address, token: Address, amount: bigint) => {
      if (!publicClient) throw new Error('No connection to the network.');
      const allowance = await publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [owner, vault],
      });
      if (allowance >= amount) return;

      if (allowance > BigInt(0)) {
        setActionState({ type: 'info', message: `Resetting the ${tokenSymbol} approval to 0 first (USDT requires this)...` });
        await waitFor(
          await writeContractAsync({
            address: token,
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [vault, BigInt(0)],
            chainId: APP_CHAIN_ID,
          }),
        );
      }

      setActionState({ type: 'info', message: `Approve ${tokenSymbol} for the vault in your wallet...` });
      await waitFor(
        await writeContractAsync({
          address: token,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [vault, amount],
          chainId: APP_CHAIN_ID,
        }),
      );
    },
    [publicClient, tokenSymbol, waitFor, writeContractAsync],
  );

  const runAction = useCallback(
    async (action: OwnerAction, amount: bigint) => {
      if (!account || !vaultAddress || !tokenAddress || !publicClient) {
        setActionState({ type: 'error', message: 'Wallet or vault is not ready yet.' });
        return false;
      }

      setPendingAction(action);
      try {
        // Everything except withdraw sends USDT from the owner to the vault.
        if (action !== 'withdraw' && amount > BigInt(0)) {
          await ensureAllowance(account, vaultAddress, tokenAddress, amount);
        }

        setActionState({ type: 'info', message: 'Confirm the transaction in your wallet...' });
        const hash = await writeContractAsync({
          address: vaultAddress,
          abi: VAULT_ROI_ABI,
          functionName: ACTION_FUNCTION[action],
          args: [amount],
          chainId: APP_CHAIN_ID,
        });
        setActionState({ type: 'info', message: 'Waiting for confirmation...' });
        await waitFor(hash);

        setActionState({ type: 'success', message: SUCCESS_MESSAGE[action] });
        await refetchBreakdown();
        onConfirmed?.();
        return true;
      } catch (error) {
        setActionState({ type: 'error', message: formatTxError(error, FAILURE_MESSAGE[action]) });
        return false;
      } finally {
        setPendingAction(null);
      }
    },
    [account, ensureAllowance, onConfirmed, publicClient, refetchBreakdown, tokenAddress, vaultAddress, waitFor, writeContractAsync],
  );

  return {
    breakdown,
    isBreakdownLoading,
    refetchBreakdown,
    runAction,
    pendingAction,
    actionState,
    setActionState,
  };
}
