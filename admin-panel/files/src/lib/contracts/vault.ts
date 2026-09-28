export {
  PRESALE_CONTRACT_ADDRESS,
  USDT_CONTRACT_ADDRESS,
  VAULT_CONTRACT_ADDRESS,
} from '@/lib/network';

export const PRINCIPAL_WITHDRAW_TOGGLED_EVENT = {
  type: 'event',
  name: 'PrincipalWithdrawToggled',
  inputs: [{ indexed: false, name: 'enabled', type: 'bool' }],
  anonymous: false,
} as const;

export const VAULT_ROI_ABI = [
  {
    type: 'function',
    name: 'BASIS_POINTS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'USDT',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'getCurrentCycle',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'cycleId', type: 'uint256' },
          { name: 'withdrawAmount', type: 'uint256' },
          { name: 'withdrawTime', type: 'uint256' },
          { name: 'tvlAtWithdraw', type: 'uint256' },
          { name: 'depositAmount', type: 'uint256' },
          { name: 'depositTime', type: 'uint256' },
          { name: 'profit', type: 'uint256' },
          { name: 'roiBps', type: 'uint256' },
          { name: 'settled', type: 'bool' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getROIHistory',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        components: [
          { name: 'roi', type: 'uint256' },
          { name: 'timestamp', type: 'uint256' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'ownerWithdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'ownerReturnPrincipal',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'ownerCloseCycleWithLoss',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amountReturned', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'distributeProfit',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'activePrincipal',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'deployedPrincipal',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'pendingPrincipal',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'profitReserve',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'ownerWithdrawable',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'principalWithdrawEnabled',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'togglePrincipalWithdraw',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  PRINCIPAL_WITHDRAW_TOGGLED_EVENT,
] as const;

export const ERC20_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;
