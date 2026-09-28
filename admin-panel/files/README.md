# Singularity Admin.....

Wallet-gated admin dashboard for managing vault owner actions, live ROI data, and principal withdraw settings.

Production (`main`) talks to **Ethereum mainnet**. Staging, Vercel Preview, and local talk to **Sepolia**. Chain is chosen from env at build/runtime — not by maintaining two code forks.

## Tech Stack

- Next.js App Router (React 19, TypeScript)
- Tailwind CSS v4
- Reown AppKit + Wagmi + Viem
- TanStack Query

## Core Functionality

- Wallet-based login on `/`
- Admin allowlist enforcement (only approved wallet can access `/roi`)
- ROI dashboard with live contract integration:
  - read current ROI from the active cycle or latest settled history
  - read ROI history
  - vault breakdown: pool, principal with the owner, deposits waiting to join, unclaimed user profit
  - distribute profit (profit only; users claim it right away)
  - withdraw principal to trade (waiting deposits join the pool first)
  - return principal (the cycle closes when all of it is back), or close the cycle with a loss
  - approve `mUSDT` / USDT for the vault when needed, resetting a leftover approval to 0 first (mainnet USDT requires it)
- principal withdraw toggle with owner-gated controls
- Logout confirmation modal with wallet disconnect

## Contract Integration

- Network: Ethereum (production) or Sepolia (staging / local)
- Vault and presale addresses come from env on Ethereum. Sepolia falls back to the current test contracts if env is omitted.

Functions used by ROI page:
- `BASIS_POINTS()`
- `USDT()`
- `getCurrentCycle()`
- `getROIHistory()`
- `owner()`
- `activePrincipal()`, `deployedPrincipal()`, `pendingPrincipal()`, `profitReserve()`, `ownerWithdrawable()`
- `distributeProfit(uint256)`
- `ownerWithdraw(uint256)`
- `ownerReturnPrincipal(uint256)`
- `ownerCloseCycleWithLoss(uint256)`
- `principalWithdrawEnabled()`
- `togglePrincipalWithdraw()`

## Environment Variables

Create `.env.local` in the project root (see `.env.example`).

Always required:
- `NEXT_PUBLIC_PROJECT_ID` — Reown / WalletConnect project ID
- `NEXT_PUBLIC_ADMIN_WALLET_ADDRESSES` — comma-separated allowlist (when enforcement is enabled)
- `NEXT_PUBLIC_DASHBOARD_API_URL` — admin ROI API (defaults to the existing dashboard API if unset)

Chain / contracts:
- `NEXT_PUBLIC_CHAIN_ID` — `1` (Ethereum) or `11155111` (Sepolia). Recommended explicit override on every Vercel project.
- `NEXT_PUBLIC_NETWORK` — `mainnet` / `ethereum` / `sepolia` (used if `CHAIN_ID` is unset)
- `NEXT_PUBLIC_VAULT_CONTRACT_ADDRESS` — **required on Ethereum**. Sepolia defaults to the test vault.
- `NEXT_PUBLIC_PRESALE_CONTRACT_ADDRESS` — **required on Ethereum** (same contracts as the public app). Sepolia defaults to the test presale.
- `NEXT_PUBLIC_USDT_CONTRACT_ADDRESS` — optional. Ethereum defaults to official USDT; Sepolia defaults to the test token.
- `NEXT_PUBLIC_VAULT_DEPLOY_BLOCK` — optional. Block the vault was deployed in; bounds the principal-withdraw "last changed" search.

If this admin app is a **separate Vercel Production deploy of the `staging` branch**, you **must** set `NEXT_PUBLIC_CHAIN_ID=11155111`. Otherwise `NEXT_PUBLIC_VERCEL_ENV=production` will select Ethereum.

Do not invent mainnet vault/presale addresses. Set them from the live deployment.

## Local Development

```bash
npm install
npm run dev
```

App runs at `http://localhost:3000` by default. Local builds use Sepolia unless `NEXT_PUBLIC_CHAIN_ID=1` is set.

## Build & Validation

```bash
npm run lint
npm run build
```

## Project Scripts

- `npm run dev` - start development server
- `npm run build` - create production build
- `npm run start` - run production server
- `npm run lint` - run ESLint

## Project Structure

- `src/app` - routes and root layout
- `src/components` - UI components and feature screens
- `src/lib/admin.ts` - admin allowlist logic
- `src/lib/network.ts` - chain + contract address resolution
- `src/lib/contracts/vault.ts` - vault ROI ABI subset
- `src/lib/wallet.ts` - AppKit/Wagmi config
- `src/providers/AppKitProvider.tsx` - global providers

## Additional Documentation

See `guide.md` for simplified functionality and flow diagrams.
