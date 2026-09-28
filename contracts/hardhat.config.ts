import hardhatKeystore from "@nomicfoundation/hardhat-keystore";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import { configVariable, defineConfig } from "hardhat/config";

// Same compiler settings as the live mainnet contracts: solc 0.8.28, optimizer on, 200 runs.
const solc = {
  version: "0.8.28",
  settings: { optimizer: { enabled: true, runs: 200 } },
};

// Secrets are read with configVariable(): from the encrypted Hardhat keystore
// (`npx hardhat keystore set NAME`) or from an environment variable of the same name.
// They are only needed when a live network is used; tests run without them.
export default defineConfig({
  plugins: [hardhatViem, hardhatNodeTestRunner, hardhatNetworkHelpers, hardhatVerify, hardhatKeystore],
  solidity: {
    profiles: {
      default: solc,
      production: solc,
    },
  },
  networks: {
    mainnet: {
      type: "http",
      chainType: "l1",
      url: configVariable("MAINNET_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
});
