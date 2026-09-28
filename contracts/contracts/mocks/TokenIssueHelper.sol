// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "../Token.sol";

/// @dev Test helper: acts as `vaultContract` on `ProjectTokenPresale` to exercise `issueTokensForDeposit`.
contract TokenIssueHelper {
    function issue(ProjectTokenPresale presale, address user, uint256 usdtAmount) external {
        presale.issueTokensForDeposit(user, usdtAmount);
    }
}
