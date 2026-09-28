# Singularity Admin Guide

## Overview
This project is a standalone admin app for managing vault owner actions, live ROI data, and principal withdraw settings. Production uses Ethereum; staging/local uses Sepolia.

- `/` is the wallet login page.
- `/roi` is the admin ROI dashboard.
- Access is wallet-gated and allowlist-enforced.

## Admin Access Logic
- Admin allowlist is now enforced in `src/lib/admin.ts`.
- Only wallets in `NEXT_PUBLIC_ADMIN_WALLET_ADDRESSES` can enter `/roi`.
- If disconnected or unauthorized, user is redirected to `/`.

## Contract Integration
Vault address comes from `NEXT_PUBLIC_VAULT_CONTRACT_ADDRESS`.
Sepolia (staging/local) falls back to `0x11105683c12efd79ca3dbbcec767fc95dd7b2c5a` if unset.
Ethereum (production) has no hardcoded vault — set the env var.

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

## Route Flow Diagram
```text
Open "/"
  |
  v
Connect wallet (Reown/AppKit)
  |
  v
Is wallet in allowlist?
  |                \
  | yes             \ no
  v                  v
Redirect to "/roi"   Stay on "/" (unauthorized)
```

## ROI Page Data/Action Flow
```text
Load /roi
  |
  +--> read owner()
  +--> read USDT()
  +--> read principalWithdrawEnabled()
  +--> read getCurrentCycle()
  +--> read BASIS_POINTS()
  +--> read getROIHistory()
  |
  v
Render principal withdraw status + current ROI + history + owner fund actions
  |
  +--> if connected wallet is not owner, keep principal withdraw control disabled
  |
  v
Click principal withdraw toggle
  |
  v
write togglePrincipalWithdraw()
  |
  v
Wait tx receipt
  |
  v
Refetch principalWithdrawEnabled() and update UI
  |
  v
Pick an owner action: Distribute Profit / Withdraw to Trade / Return Principal / Close With Loss
  |
  v
Enter amount (Max / Return all fill it in)
  |
  v
If sending USDT and allowance is too low: reset a leftover approval to 0, then approve the amount
  |
  v
Send the vault call and wait for the receipt
  |
  v
Refetch vault breakdown + balances + ROI + history and update UI
```

## Logout Flow
```text
Click logout icon in header
  |
  v
Confirmation modal opens
  |
  +--> Cancel: close modal
  |
  +--> Confirm: disconnect wallet -> redirect to "/"
```

## Quick Verification Checklist
- Connect a non-admin wallet -> `/roi` must be blocked.
- Connect admin wallet -> `/roi` should open.
- Withdraw to Trade with the owner wallet -> waiting deposits join, a cycle opens.
- Distribute Profit -> users can claim it; ROI history gets a new row.
- Return Principal (Return all) -> the cycle closes.
- With a leftover USDT approval, an action first resets it to 0, then approves.
- Check the vault breakdown and ROI history update after each confirmation.
