/**
 * Deploys VaultContractV2.
 *
 *   VAULT_OWNER=0x... npx hardhat run scripts/deploy-vault-v2.ts --network sepolia
 *   VAULT_OWNER=0x... DEPLOY_CONFIRM=mainnet npx hardhat run scripts/deploy-vault-v2.ts --network mainnet
 *
 * VAULT_OWNER    Address that owns the vault from its first block. The deployer
 *                gets no rights, so any wallet with gas money can deploy.
 * USDT_ADDRESS   Optional on mainnet (defaults to Tether USDT); required elsewhere.
 * DEPLOY_CONFIRM Must be "mainnet" to deploy on chain 1 (guards against accidents).
 *
 * The script only deploys and checks the result. Linking the presale and the
 * token (see DEPLOY.md) is done afterwards by the owner.
 */
import { network } from "hardhat";
import { getAddress, isAddress, formatEther, zeroAddress } from "viem";

const MAINNET_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

function requireAddress(name: string, value: string | undefined): `0x${string}` {
  if (!value || !isAddress(value) || getAddress(value) === zeroAddress) {
    throw new Error(`${name} must be set to a valid, non-zero address (got "${value ?? ""}")`);
  }
  return getAddress(value);
}

const { viem, networkName } = await network.create();
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
const chainId = await publicClient.getChainId();

const owner = requireAddress("VAULT_OWNER", process.env.VAULT_OWNER);
const usdt = requireAddress("USDT_ADDRESS", process.env.USDT_ADDRESS ?? (chainId === 1 ? MAINNET_USDT : undefined));

if (chainId === 1 && process.env.DEPLOY_CONFIRM !== "mainnet") {
  throw new Error('Refusing to deploy to mainnet without DEPLOY_CONFIRM=mainnet');
}
if (!(await publicClient.getCode({ address: usdt }))) {
  throw new Error(`USDT_ADDRESS ${usdt} has no contract code on ${networkName}`);
}

const balance = await publicClient.getBalance({ address: deployer.account.address });
console.log(`Network:   ${networkName} (chain ${chainId})`);
console.log(`Deployer:  ${deployer.account.address} (${formatEther(balance)} ETH)`);
console.log(`USDT:      ${usdt}`);
console.log(`Owner:     ${owner}`);

const { contract: vault, deploymentTransaction } = await viem.sendDeploymentTransaction("VaultContractV2", [usdt, owner]);
console.log(`Tx:        ${deploymentTransaction.hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentTransaction.hash });
if (receipt.status !== "success") throw new Error("Deployment transaction reverted");

const [onChainOwner, onChainUsdt, paused] = await Promise.all([
  vault.read.owner(),
  vault.read.USDT(),
  vault.read.paused(),
]);
if (getAddress(onChainOwner) !== owner) throw new Error(`owner() is ${onChainOwner}, expected ${owner}`);
if (getAddress(onChainUsdt) !== usdt) throw new Error(`USDT() is ${onChainUsdt}, expected ${usdt}`);

console.log(`\nVaultContractV2 deployed at ${vault.address} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
console.log(`owner() = ${onChainOwner}, paused() = ${paused}`);
console.log("\nNext (see DEPLOY.md):");
console.log(`  1. Verify:  npx hardhat verify --network ${networkName} ${vault.address} ${usdt} ${owner}`);
console.log("  2. Owner:   vault.pause() until launch, then vault.setPresaleContract(<SLF token>)");
console.log("  3. Owner:   switch over in the order given in DEPLOY.md");
