// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVaultRecord {
    function recordDepositFrom(address user, uint256 amount) external;
}

/// @dev Test double for a buggy or malicious presale that records a deposit without sending USDT.
contract FakePresale {
    bool public presaleActive = true;

    function issueTokensForDeposit(address, uint256) external {}

    function recordWithoutPaying(IVaultRecord vault, address user, uint256 amount) external {
        vault.recordDepositFrom(user, amount);
    }
}
