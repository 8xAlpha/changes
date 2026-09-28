# Singularity Vault V2

The upgrade to the Singularity USDT vault. It keeps the same concept (users deposit USDT, the owner trades it in cycles, users earn a share of the profit) and fixes how profit and principal move:

- The owner sends **profit on its own**, at any time. Users can claim it straight away.
- **Principal is tracked separately:** it goes out to trade and comes back, and it unlocks for users only once it's all back (or the loss is recorded).
- **Losses are recorded** and shared fairly, instead of leaving a hidden shortfall.
- **The owner can't withdraw users' unclaimed profit** or deposits that haven't joined the pool yet.
- It works with the **live SLF token and presale unchanged**.

## What's in here

| Path | Contents |
|---|---|
| [`contracts/`](contracts) | Hardhat 3 project: `VaultContractV2.sol` (new), `VaultContract.sol` (the live v1 vault, for reference and migration tests), `Token.sol` (the live SLF token and presale, unchanged), mocks, tests and the deploy script |
| [`admin-panel/`](admin-panel) | The admin panel changes for the new vault, as a patch and as full copies of the changed files |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed from v1 and why, function and event mapping, known and accepted items |
| [`DEPLOY.md`](DEPLOY.md) | Deployment, switch-over order and rollback |

## Quick start

```bash
cd contracts
npm ci
npm test        # 82 passing
```

No keys or RPC URLs are needed to build or test.

## Live contracts (Ethereum mainnet)

| Contract | Address |
|---|---|
| SLF token / presale | `0x6723944FCcc38655C9B7D06Ef7fBE8780Ffa8028` |
| Vault v1 (current) | `0xEd806077D527b432835FF8B90A40531AaEBE2b8C` |
| USDT | `0xdAC17F958D2ee523a2206206994597C13D831ec7` |
| Vault v2 | Not deployed yet |

## Website: one required change (not included)

The website works with the new vault as it is, except for one thing. `WithdrawModal.tsx` only allows profit withdrawal when the deposit status is `2`. In v2, profit can be claimed at any time, so allow it whenever `pendingProfit > 0` and the deposit hasn't been withdrawn. Optionally, show `principalOf` instead of the original `amount` after a loss. Then set the new vault address in the website's environment variables. See `CHANGELOG.md` §9 for all integration points, including the API server.

## Important

Use the `contracts/` folder in this repository as the base for any contract work. Don't build or deploy from older copies of the contract repository.
