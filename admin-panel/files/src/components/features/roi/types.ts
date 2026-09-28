export type RoiHistoryItem = {
  roi: bigint;
  timestamp: bigint;
};

export type CurrentCycle = {
  cycleId: bigint;
  withdrawAmount: bigint;
  withdrawTime: bigint;
  tvlAtWithdraw: bigint;
  depositAmount: bigint;
  depositTime: bigint;
  profit: bigint;
  roiBps: bigint;
  settled: boolean;
};

export type ActionState = {
  type: 'info' | 'success' | 'error';
  message: string;
};

/** Owner actions on the vault: send profit, bring principal back, close with a loss, take principal to trade. */
export type OwnerAction = 'profit' | 'return' | 'loss' | 'withdraw';

export type FundsModalType = OwnerAction | null;

/** Where the vault's USDT stands, from the owner's point of view. */
export type VaultBreakdown = {
  /** Principal of every deposit in the pool, deployed or not. */
  activePrincipal?: bigint;
  /** Principal the owner has taken out and not returned yet (> 0 means a cycle is open). */
  deployedPrincipal?: bigint;
  /** Deposits waiting to join the pool at the next withdraw. */
  pendingPrincipal?: bigint;
  /** Profit sent to users and not claimed yet. */
  profitReserve?: bigint;
  /** The most `ownerWithdraw` accepts right now. */
  ownerWithdrawable?: bigint;
};

export type RoiHistoryRow = {
  id: string;
  date: string;
  roiPct: string;
};
