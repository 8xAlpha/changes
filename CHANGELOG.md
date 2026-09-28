# Singularity Vault V2: Change Log & Migration Guide

## 1. Scope

| Part | Where in this repo | Status |
|---|---|---|
| New vault contract (`VaultContractV2`) + tests + deploy script | `contracts/` | Not deployed |
| Admin panel changes for the new vault | `admin-panel/` (patch + changed files) | Not merged, not deployed |
| SLF token / presale (`Token.sol`) | `contracts/contracts/Token.sol` | Unchanged, live |
| Website | Not included | One required change, see §9 |

**Reference ("live vault" / v1):** the vault deployed at `0xEd806077D527b432835FF8B90A40531AaEBE2b8C`. Its bytecode matches `contracts/VaultContract.sol` in this repo (solc 0.8.28, optimizer 200 runs).

**Unchanged:** `contracts/Token.sol` (the SLF token and presale: price, supply, hard cap, `buy()`), live at `0x6723944FCcc38655C9B7D06Ef7fBE8780Ffa8028`. The new vault works with the live token as it is, verified on a mainnet fork.

---

## 2. What's new and why

| # | Change | Reason |
|---|---|---|
| 1 | **Profit is sent on its own** (`distributeProfit`). Every active deposit can claim its share at any time. | The owner no longer round-trips principal to pay profit |
| 2 | **Profit claims use a running per-share total**, not cycle-by-cycle claims | A 0% cycle permanently blocked `withdrawProfit` in v1 |
| 3 | **Principal is tracked separately:** `ownerWithdraw` takes it out, `ownerReturnPrincipal` brings it back, and the cycle closes when it's all back | Separates principal from profit |
| 4 | **Losses are recorded** (`ownerCloseCycleWithLoss`) and shared by active deposits in proportion to their principal | v1 left losses unrecorded (a hidden shortfall) |
| 5 | **The owner can't withdraw unclaimed user profit or deposits that haven't joined** | User protection |
| 6 | **Principal unlocks only after a deposit has completed a cycle** (joined, and that cycle has closed), and only while no cycle is open | v1's lock rule, restored by the C-1 fix. Stops buy-and-refund / flash-loan theft of presale SLF. |
| 7 | **Two-step ownership transfer; renounce disabled; owner set in the constructor** | Prevents lost or bricked ownership |
| 8 | **`recordDepositFrom` checks that the USDT actually arrived** | Stops a faulty presale from recording deposits nobody paid for |
| 9 | **The user-facing ABI matches what the website already calls**, and statuses use the website's 0–3 numbering | Minimal frontend change; also fixes the website's current status-label bug |
| 10 | **The cycle record keeps v1's `AdminCycle` layout** | The admin ROI panel reads it without code changes |

---

## 3. Behaviour: v1 → v2

| Area | Live vault (v1) | New vault (v2) |
|---|---|---|
| Paying profit | `ownerDeposit(withdrawn + profit)`, a single deposit that closes the cycle | `distributeProfit(profit)`, any time, any number of times |
| Returning principal | Part of `ownerDeposit` | `ownerReturnPrincipal(x)`, partial or full. The cycle closes at 0 deployed. |
| Losses | Returning less than withdrawn → 0% ROI, principal accounting unchanged (hole) | `ownerCloseCycleWithLoss(returned)` → principal reduced for everyone in the pool, in proportion |
| Opening a cycle | `ownerWithdraw`, one per cycle; previous cycle must be settled; any amount up to the balance | `ownerWithdraw`, can be called repeatedly within a cycle; capped at `ownerWithdrawable()` |
| New deposits | Assigned to the next cycle | Wait as "pending"; join the pool at the owner's next `ownerWithdraw` (or `activatePendingDeposits`) |
| Profit earned | Per cycle: `amount × cycle ROI` | Per distribution: by share of current principal in the pool |
| `withdrawProfit(i)` | Pays the **next** unclaimed cycle only; reverts on a 0% cycle | Pays **all** accrued profit; never blocked |
| `withdrawPrincipal(i)` | Assigned cycle settled + current cycle settled + switch on | Deposit has completed a cycle + no cycle open + switch on. Pays principal (after losses) + unclaimed profit. |
| `pendingProfit(user,i)` | Next cycle's profit only | All claimable profit |
| Deposit statuses (`getDepositStatus`) | 0 Waiting, 1 CycleInProgress, 2 LockedInNewCycle, 3 ReadyToWithdraw, 4 Withdrawn | **0 Waiting, 1 InCycle, 2 Ready, 3 Withdrawn**. "Waiting" also covers deposits that joined but haven't completed a cycle. |
| `isDepositUnlocked` | Ignores the principal-withdraw switch | Includes the switch and the completed-cycle rule |
| Ownership | Single-step `transferOwnership`; `renounceOwnership` works | Two-step (`transferOwnership` → `acceptOwnership`); renounce reverts |
| Constructor | `(usdt)`, owner = deployer | `(usdt, initialOwner)` |
| Moderators | Present but unused | Removed |

---

## 4. Function mapping (v1 → v2)

### 4.1 Identical signature (29)

**Same behaviour:**
`BASIS_POINTS` · `USDT` · `deposit` · `recordDepositFrom` (plus a USDT-received check) · `minDeposit` · `setMinDeposit` · `owner` · `pause` · `unpause` · `paused` · `presaleContract` · `setPresaleContract` · `principalWithdrawEnabled` · `togglePrincipalWithdraw` · `totalPrincipalWithdrawn` · `totalProfitWithdrawn`

**Same signature, different meaning (see §3):**

- `ownerWithdraw`
- `withdrawProfit`
- `withdrawPrincipal`
- `pendingProfit`
- `totalPendingProfit` (now equals `pendingProfit`)
- `getDepositStatus` (0–3)
- `isDepositUnlocked`
- `renounceOwnership` (reverts)
- `transferOwnership` (two-step)
- `getUserDeposits`: same 6-field layout, but field 3 = `activationRound` (was `assignedCycleId`) and field 6 = `principalPaid` (was `lastClaimedCycleId`); `amount` is still zeroed on withdrawal
- `getCycle` / `getCurrentCycle`: same 9-field `AdminCycle` layout, reinterpreted as below
- `getROIHistory`: same `{roi, timestamp}`, but one entry **per distribution** (was per cycle)

**Cycle record (`AdminCycle`) fields in v2:**

| Field | v2 meaning |
|---|---|
| `withdrawAmount` | Total principal taken out during the cycle |
| `withdrawTime` | When the cycle opened |
| `tvlAtWithdraw` | Pool when the cycle opened |
| `depositAmount` | Principal returned |
| `depositTime` | When the cycle closed (0 while open) |
| `profit` | Profit distributed during the cycle |
| `roiBps` | `profit / tvlAtWithdraw` so far |
| `settled` | Cycle closed |
| *(new, separate)* `cycleLoss(id)` | Loss written off at close |

### 4.2 Removed / replaced (26)

| v1 | v2 replacement |
|---|---|
| `ownerDeposit(uint256)` | `distributeProfit` + `ownerReturnPrincipal` + `ownerCloseCycleWithLoss` |
| `totalDeposited()` | `totalValueLocked()` (active after losses + pending) |
| `getEligibleTVL()` | `activePrincipal()` |
| `pendingDeposits()` | `pendingPrincipal()` |
| `userProfitLiability()` | `profitReserve()` (actual reserved USDT) |
| `ownerTradingBalance()`, `ownerWithdrawableBalance()` | `ownerWithdrawable()` |
| `adminCycleCount()`, `currentCycleId()` | `cycleCount()` |
| `adminCycles(uint256)` | `getCycle(uint256)` |
| `roiHistory(uint256)` | `getROIHistory()` |
| `userDeposits(address,uint256)` | `getUserDeposits(address)` |
| `cycleAssignedDeposits(uint256)` | None (replaced by activation rounds) |
| `getDepositHistory`, `getProfitWithdrawHistory`, `getPrincipalWithdrawHistory`, `depositHistory`, `profitWithdrawHistory`, `principalWithdrawHistory` | None. Use events `Deposited`, `ProfitWithdrawn`, `PrincipalWithdrawn`. |
| `getOwnerDepositHistory`, `getOwnerWithdrawHistory`, `ownerDepositHistory`, `ownerWithdrawHistory` | None. Use events `OwnerWithdrawn`, `PrincipalReturned`, `ProfitDistributed`. |
| `addModerator`, `removeModerator`, `moderators` | Removed (they were unused) |

### 4.3 New (32)

| Purpose | Functions |
|---|---|
| Owner: principal | `ownerReturnPrincipal`, `ownerCloseCycleWithLoss`, `activatePendingDeposits` |
| Owner: profit | `distributeProfit` |
| Owner: admin | `sweepSurplus`, `migrateDeposits`, `finalizeMigration`, `acceptOwnership`, `pendingOwner` |
| User | `withdrawAllProfit` |
| Views: pool | `activePrincipal`, `deployedPrincipal`, `pendingPrincipal`, `totalValueLocked`, `isCycleOpen`, `ownerWithdrawable`, `profitReserve`, `surplus`, `totalProfitDistributed`, `cycleCount`, `cycleLoss` |
| Views: user | `principalOf`, `claimableProfitOf` |
| Accounting internals (public) | `totalShares`, `principalPerShare`, `accProfitPerShare`, `currentRound`, `roundPrincipalPerShare`, `roundAccProfitPerShare`, `roundFirstCycle`, `MAX_DEPOSITS_PER_WALLET`, `migrationFinalized` |

---

## 5. Event mapping

**Identical signature (10):**
`MinDepositUpdated` · `OwnershipTransferred` · `Paused` · `Unpaused` · `PresaleContractSet` · `PrincipalWithdrawToggled` · `TokensIssuedOnDeposit` · `Deposited` · `ProfitWithdrawn` · `PrincipalWithdrawn`

Three of those keep their signatures, but the **third parameter's meaning changed:**

- `Deposited`: 3rd param is now `activationRound` (was `assignedCycleId`)
- `ProfitWithdrawn`: 3rd param is now `depositIndex` (was `cycleId`)
- `PrincipalWithdrawn`: 3rd param is now `depositIndex` (was `assignedCycleId`)

**Removed or changed:**

| v1 event | v2 |
|---|---|
| `CycleOpened(cycleId indexed, withdrawAmount, tvlSnapshot)` | `CycleOpened(cycleId indexed, tvlAtWithdraw)`, a **different signature**, plus `OwnerWithdrawn` for the amount |
| `CycleSettled(cycleId indexed, depositAmount, profit, roiBps)` | `CycleClosed(cycleId indexed, returned, loss)`. Profit is now in `ProfitDistributed`. |
| `ROIUpdated(oldROI, newROI)` | `ProfitDistributed(amount, roiBps, cycleId indexed)` |
| `OwnerDeposited(amount, cycleId)` | `PrincipalReturned(amount, cycleId indexed)` and/or `ProfitDistributed` |
| `OwnerWithdrawn(amount, cycleId)` | `OwnerWithdrawn(amount, cycleId indexed)`. **Same topic, different data layout**, so a v1 decoder will fail. |
| `ModeratorAdded`, `ModeratorRemoved` | Removed |

**New:** `DepositsActivated` · `CycleClosed` · `PrincipalReturned` · `ProfitDistributed` · `SurplusSwept` · `DepositMigrated` · `MigrationFinalized` · `OwnershipTransferStarted`

---

## 6. Deliberately not changed (known and accepted)

These were found in testing and **intentionally left as they are**, by the owner's decision. They are not oversights.

| ID | Item | Handling |
|---|---|---|
| M-1 | Newcomers joining mid-cycle share an unrealized loss | Operational: don't do the weekly withdraw while trades are down |
| M-2 | Profit distributed after newcomers join is shared with them | Operational: always **distribute → then withdraw**; the admin panel guides this |
| L-1 / F1 | Profit sent to an empty pool (leftover rounding shares) is stuck | **Admin panel blocks distribution when the pool is 0** |
| L-2 | Status shows "Ready" while the principal-withdraw switch is off | The website also checks the switch |
| L-3 | The 100-deposit limit is lifetime, not concurrent | Accepted (same as v1) |
| L-4 / F3 | Precision degrades after extreme cumulative losses (>99.9999%) | Accepted |
| L-5 | Withdraw-max can be front-run during a window | Operational: switch principal withdrawals off before opening a cycle; the panel suggests it |
| L-6 | A direct deposit over the remaining presale cap gets 0 SLF | Accepted (same as v1) |
| L-7 | `migrateDeposits` can be blocked by a user with 100 deposits | Migration isn't needed (current funds are the owner's own) |
| I-1 | Presale `buy()` ignores the vault's `minDeposit` | Accepted (same as v1) |
| I-2 | USDT fee switch (currently 0) would over-credit direct deposits | Accepted; monitor |
| I-3 | Owner is fully trusted | By design; consider a multisig |
| F2 | Rounding after losses slightly favours later joiners (≤ ~0.00001 USDT) | Accepted |
| — | Gas micro-optimizations | Skipped (low value for the risk) |

---

## 7. Tests (`contracts/`)

- `test/VaultContractV2.test.ts`: covers ownership, website/admin ABI compatibility (decoded with the *exact* ABIs they use today), deposits, profit, principal, losses, the presale, mainnet-USDT behaviour (`MockTetherUSDT`), admin functions, **C-1 attack regressions** (flash-loan, buy-then-refund, deposit recycling, activation in a window, mid-cycle joiners), and a randomized solvency test.
- Mocks: `MockTetherUSDT`, `FakePresale`, `FlashLenderMock`, `PresaleFreeRiderMock`.
- `npm test` runs the v1, token and v2 suites: **82 passing** with default settings. Raise `SOLVENCY_SEEDS` / `SOLVENCY_STEPS` for a longer randomized run (12 seeds: 93 passing).
- Also run against this code during review (not included here): a mainnet-fork test with real USDT and the live SLF token, and a 15,000-user scale test (owner gas flat, 0 pro-rata error).

---

## 8. Admin panel changes (`admin-panel/`)

| File | Change |
|---|---|
| `src/lib/contracts/vault.ts` | ABI: removed `ownerDeposit`; added `distributeProfit`, `ownerReturnPrincipal`, `ownerCloseCycleWithLoss`, `activePrincipal`, `deployedPrincipal`, `pendingPrincipal`, `profitReserve`, `ownerWithdrawable` |
| `src/components/features/roi/useOwnerVaultActions.ts` | **New.** Reads the vault breakdown; runs each owner action as one sequence: reset a leftover USDT approval to 0 → approve → call → wait → refresh |
| `src/components/features/roi/RoiScreen.tsx` | Removed the allowance read, vault-balance read and the approve/deposit/withdraw hooks, effects and handlers; uses the new hook; "last changed" log search in bounded windows; refreshes numbers when a popup opens |
| `src/components/features/roi/OwnerVaultActionsPanel.tsx` | Breakdown cards (Pool · With you · Waiting to join · Unclaimed user profit), cycle status, **Distribute Profit / Withdraw to Trade / Return Principal**, and a "Close cycle with a loss…" link |
| `src/components/features/roi/FundsActionModal.tsx` | One popup, four variants: ROI and loss previews, Max / Return all, a "profit distributed first" confirmation when closing a cycle, a confirmation for losses, and blocking distribution to an empty pool |
| `src/components/features/roi/PrincipalWithdrawPanel.tsx` | Reminder when principal withdrawals are OFF |
| `src/components/features/roi/types.ts` | `OwnerAction`, `FundsModalType`, `VaultBreakdown` |
| `src/lib/network.ts`, `.env.example` | Optional `NEXT_PUBLIC_VAULT_DEPLOY_BLOCK` |
| `README.md`, `guide.md` | Updated flow and function list |

**Unchanged:** login and allowlist, header and logout, network enforcement, the ROI panel (Current ROI, Auto/Manual via the API, ROI history), `EditRoiModal`, `roi-api`, `roi-auth`, wallet config.

**Caution:** these changes only work with the new vault. Apply them at switch-over, together with changing the vault address in Vercel.

---

## 9. Integration impact

| Component | Impact |
|---|---|
| **SLF token / presale** | None. Link it with `token.setVaultContract(newVault)`. |
| **Admin panel** | Ready (`admin-panel/`). Set `NEXT_PUBLIC_VAULT_CONTRACT_ADDRESS`, and optionally `NEXT_PUBLIC_VAULT_DEPLOY_BLOCK`. |
| **Website** | Works as is, **except one required change:** `WithdrawModal.tsx` only allows profit withdrawal when status == 2. Allow it whenever `pendingProfit > 0` and the deposit isn't withdrawn. Optional: show `principalOf` instead of the original `amount` after losses. Set the vault address env var. |
| **API server** | **Needs a review.** Check it for any use of the removed functions (§4.2), the removed or changed events (§5), and the changed third-parameter meanings. Make "available balance / lifetime earnings / next profit" match the vault's own numbers. |
| **Deployment** | Use `contracts/scripts/deploy-vault-v2.ts` (see `DEPLOY.md`). The old repository's `scripts/deploy.ts` deploys the old vault *and a new token*, so don't use it. |

## 10. Switch-over

The deployment steps, switch-over order and rollback are in [`DEPLOY.md`](DEPLOY.md).
