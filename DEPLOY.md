# Deploying Vault V2

## 0. Before you start

- **Deploy from a clean machine.**
- **The deployer wallet gets no rights.** The owner is passed to the constructor (`VAULT_OWNER`) and owns the vault from its first block. Any fresh wallet with gas money can deploy, so the owner's key is never needed on the deploying machine.
- **Cost:** deployment uses about 3.0M gas (about 0.003 ETH at 1 gwei). Fund the deployer with 0.01–0.02 ETH to be safe. The owner's setup transactions below use about 150k gas in total.
- The compiler settings match the live contracts: solc 0.8.28, optimizer on, 200 runs.

## 1. Install and test

```bash
cd contracts
npm ci
npm test
```

## 2. Set the secrets

Store them in Hardhat's encrypted keystore (recommended) or pass them as environment variables with the same names. Never commit them.

```bash
npx hardhat keystore set MAINNET_RPC_URL
npx hardhat keystore set DEPLOYER_PRIVATE_KEY
npx hardhat keystore set ETHERSCAN_API_KEY
# for a rehearsal on Sepolia:
npx hardhat keystore set SEPOLIA_RPC_URL
```

## 3. Rehearse on Sepolia (recommended)

```bash
VAULT_OWNER=<test owner address> USDT_ADDRESS=<Sepolia USDT> npm run deploy:sepolia
```

## 4. Deploy on mainnet

```bash
VAULT_OWNER=<owner address> DEPLOY_CONFIRM=mainnet npm run deploy:mainnet
```

The script refuses to run without `VAULT_OWNER`, and refuses mainnet without `DEPLOY_CONFIRM=mainnet`. USDT defaults to Tether on mainnet. After deploying, it checks that `owner()` and `USDT()` are correct and prints the vault address.

Then verify the source:

```bash
npx hardhat verify --network mainnet <vault address> 0xdAC17F958D2ee523a2206206994597C13D831ec7 <owner address>
```

On Etherscan, under **Read Contract**, check that `owner()` shows the owner address.

## 5. Switch-over

Steps 1 to 4 are signed by the **owner wallet**, through Etherscan's **Write Contract** tab or the admin panel.

1. New vault: `pause()`. It stays closed until launch.
2. Old vault (`0xEd806077D527b432835FF8B90A40531AaEBE2b8C`): `pause()`.
3. New vault: `setPresaleContract(0x6723944FCcc38655C9B7D06Ef7fBE8780Ffa8028)`, then `unpause()`.
4. SLF token (`0x6723944FCcc38655C9B7D06Ef7fBE8780Ffa8028`): `setVaultContract(<new vault>)`. **This is the switch.**
5. Vercel, admin panel and website: set `NEXT_PUBLIC_VAULT_CONTRACT_ADDRESS` to the new vault. Admin panel only, optional: set `NEXT_PUBLIC_VAULT_DEPLOY_BLOCK` to its deployment block. Deploy the admin panel changes (`admin-panel/`) and the website change (see `README.md`).
6. API server: switch it to the new vault.
7. Check with one small real buy. It should appear in the vault, the dashboard, the admin panel and the API.
8. Publish the new official contract address.

**Rollback:** on the SLF token, `setVaultContract(<old vault>)`, then `unpause()` on the old vault and `pause()` on the new one.

## Notes

- The principal-withdraw switch starts **ON** at deployment. The owner can change it with `togglePrincipalWithdraw()`.
- **Ownership transfer is two-step:** the owner calls `transferOwnership(newOwner)`, then the new owner calls `acceptOwnership()`. `renounceOwnership()` is disabled.
- **Owner's weekly order:** distribute the period's profit first, then withdraw to trade. The admin panel guides this; see `CHANGELOG.md` §6.
