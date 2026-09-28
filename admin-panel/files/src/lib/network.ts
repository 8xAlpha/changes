import { mainnet, sepolia, type AppKitNetwork } from '@reown/appkit/networks';

export const MAINNET_CHAIN_ID = 1;
export const SEPOLIA_CHAIN_ID = 11155111;

const SEPOLIA_ADDRESSES = {
  vault: '0x11105683c12efd79ca3dbbcec767fc95dd7b2c5a',
  presale: '0x7551276f957c4bf95c762271693d2f93aa69c107',
  usdt: '0xc82d39eab653a7ec66d1b017d7cb1ea4ac9e6e9e',
} as const;

const MAINNET_USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

function parseSupportedChainId(value: string | undefined): number | null {
  if (!value) return null;
  const chainId = Number(value);
  if (chainId === MAINNET_CHAIN_ID || chainId === SEPOLIA_CHAIN_ID) return chainId;
  return null;
}

function resolveAppChainId(): number {
  const fromChainId = parseSupportedChainId(process.env.NEXT_PUBLIC_CHAIN_ID);
  if (fromChainId) return fromChainId;

  const network = process.env.NEXT_PUBLIC_NETWORK?.toLowerCase();
  if (network === 'mainnet' || network === 'ethereum') return MAINNET_CHAIN_ID;
  if (network === 'sepolia') return SEPOLIA_CHAIN_ID;

  // Vercel Production deploys from `main`. Preview/staging and local stay on Sepolia.
  if (process.env.NEXT_PUBLIC_VERCEL_ENV === 'production') return MAINNET_CHAIN_ID;

  return SEPOLIA_CHAIN_ID;
}

function envAddress(value: string | undefined): `0x${string}` | undefined {
  if (value && /^0x[a-fA-F0-9]{40}$/.test(value)) return value as `0x${string}`;
  return undefined;
}

export const APP_CHAIN_ID = resolveAppChainId();
export const isMainnetApp = APP_CHAIN_ID === MAINNET_CHAIN_ID;
export const appNetwork = (isMainnetApp ? mainnet : sepolia) as AppKitNetwork;
export const appNetworks = [appNetwork] as [AppKitNetwork, ...AppKitNetwork[]];
export const appChainName = isMainnetApp ? 'Ethereum' : 'Sepolia';
export const appChainLabel = isMainnetApp ? 'Ethereum mainnet' : 'Sepolia testnet';

export const VAULT_CONTRACT_ADDRESS = (envAddress(process.env.NEXT_PUBLIC_VAULT_CONTRACT_ADDRESS) ??
  (isMainnetApp ? undefined : SEPOLIA_ADDRESSES.vault)) as `0x${string}` | undefined;

export const PRESALE_CONTRACT_ADDRESS = (envAddress(process.env.NEXT_PUBLIC_PRESALE_CONTRACT_ADDRESS) ??
  (isMainnetApp ? undefined : SEPOLIA_ADDRESSES.presale)) as `0x${string}` | undefined;

export const USDT_CONTRACT_ADDRESS = (envAddress(process.env.NEXT_PUBLIC_USDT_CONTRACT_ADDRESS) ??
  (isMainnetApp ? MAINNET_USDT_ADDRESS : SEPOLIA_ADDRESSES.usdt)) as `0x${string}`;

export const hasAppContracts = Boolean(VAULT_CONTRACT_ADDRESS && PRESALE_CONTRACT_ADDRESS && USDT_CONTRACT_ADDRESS);

/** Block the vault was deployed in; bounds event-log searches. Optional. */
export const VAULT_DEPLOY_BLOCK = /^\d+$/.test(process.env.NEXT_PUBLIC_VAULT_DEPLOY_BLOCK ?? '')
  ? BigInt(process.env.NEXT_PUBLIC_VAULT_DEPLOY_BLOCK as string)
  : undefined;

export function isAppChain(chainId: number | string | undefined | null): boolean {
  return Number(chainId) === APP_CHAIN_ID;
}
