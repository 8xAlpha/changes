// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./VaultContract.sol";

/** Minimal inheritor to test VaultContract in isolation */
contract TestVault is VaultContract {
    constructor(address usdtAddress) VaultContract(usdtAddress) {}
}
