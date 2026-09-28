# Admin panel changes for Vault V2

These changes switch the admin panel's owner actions to the new vault. **They only work with Vault V2.** Apply and deploy them at switch-over (`DEPLOY.md` §5), not before.

## What changed

- **Owner actions are now:** **Distribute Profit**, **Withdraw to Trade**, **Return Principal**, and **Close cycle with a loss…** (all in one popup, with previews and confirmations).
- **Breakdown cards:** Pool (earning) · With you · Waiting to join · Unclaimed user profit.
- **Mainnet USDT approvals:** a leftover approval is reset to 0 before approving again.
- **"Last changed" log search** runs in bounded block windows, so it works with mainnet RPC providers.
- **Unchanged:** login and allowlist, network handling, the ROI panel (Auto/Manual via the API), ROI history, and wallet config.

File-by-file details are in `../CHANGELOG.md` §8.

## How to apply

The patch is based on the admin panel's `main` at commit `8331946` ("Merge pull request #2 from 8xAlpha/admin-fixes").

From the admin panel repository root:

```bash
git apply --3way /path/to/admin-panel-changes.patch
```

Or copy the files under [`files/`](files) over the same paths.

## Configuration

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_VAULT_CONTRACT_ADDRESS` | The new vault's address |
| `NEXT_PUBLIC_VAULT_DEPLOY_BLOCK` | Optional. The vault's deployment block, to bound event-log searches |

## Checks

`npm run lint`, `npx tsc --noEmit` and `npm run build` passed on the patched code.
