// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Test double for mainnet USDT's quirks: transfer/transferFrom/approve return nothing,
///      and approve reverts when changing a non-zero allowance to another non-zero value.
contract MockTetherUSDT {
    string public constant name = "Tether USD";
    string public constant symbol = "USDT";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        require(!(amount != 0 && allowance[msg.sender][spender] != 0), "USDT: reset allowance to 0 first");
        allowance[msg.sender][spender] = amount;
    }
}
