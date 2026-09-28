// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract ProjectTokenPresale is ERC20, ERC20Burnable, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────
    //                      USDT TOKEN
    // ─────────────────────────────────────────────────────────

    IERC20 public immutable USDT;

    address public vaultContract;
    event VaultContractSet(address indexed vault);

    function setVaultContract(address _vault) external onlyOwner {
        require(_vault != address(0), "Zero address");
        require(_vault.code.length > 0, "Vault must be a contract");
        require(_vault != vaultContract, "Same address");
        vaultContract = _vault;
        emit VaultContractSet(_vault);
    }

    modifier onlyVault() {
        require(msg.sender == vaultContract, "Caller is not the vault");
        _;
    }

    // ─────────────────────────────────────────────────────────
    //                       TOKENOMICS
    // ─────────────────────────────────────────────────────────

    uint256 public constant TOTAL_SUPPLY = 200_000_000 * 1e18;

    uint256 public constant PRESALE_SUPPLY = 110_000_000 * 1e18; // 55%
    uint256 public constant LIQUIDITY_SUPPLY = 40_000_000 * 1e18; // 20%
    uint256 public constant TREASURY_SUPPLY = 10_000_000 * 1e18; //  5%
    uint256 public constant TEAM_SUPPLY = 30_000_000 * 1e18; // 15%
    uint256 public constant MARKETING_SUPPLY = 10_000_000 * 1e18; //  5%

    // ─────────────────────────────────────────────────────────
    //                     PRESALE CONFIG
    // ─────────────────────────────────────────────────────────

    /// @dev 1e5 = $0.10 per token (USDT has 6 decimals)
    ///      tokensOut = (usdtAmount * 1e18) / 1e5
    ///      e.g. 100 USDT (100 * 1e6) → (100e6 * 1e18) / 1e5 = 1 000 * 1e18 tokens ✓
    uint256 public constant PRICE_IN_USDT = 1e5;

    /// @notice Hard cap: $11,000,000 USDT
    uint256 public constant HARD_CAP = 11_000_000 * 1e6;

    /// @notice Minimum buy amount in USDT (6 decimals).
    ///         Default: $50 USDT = 50_000_000 (50 * 1e6).
    ///         Updatable by owner.
    uint256 public minBuy = 1 * 1e6;

    uint256 public totalRaised;
    bool public presaleActive = true;

    function setMinBuy(uint256 _minBuy) external onlyOwner {
        require(_minBuy > 0, "Min buy must be > 0");
        uint256 old = minBuy;
        minBuy = _minBuy;
        emit MinBuyUpdated(old, _minBuy);
    }

    // ─────────────────────────────────────────────────────────
    //                      BURN TRACKING
    // ─────────────────────────────────────────────────────────

    /// @notice Total tokens burned across all burn types (all-time).
    uint256 public totalBurned;

    struct BurnRecord {
        address burner;
        uint256 amount;
        uint256 timestamp;
        string burnType; // "UNSOLD", "USER", "APPROVED"
    }

    BurnRecord[] private _burnHistory;

    /// @notice Returns the full burn history array.
    function getBurnHistory() external view returns (BurnRecord[] memory) {
        return _burnHistory;
    }

    /// @notice Returns total tokens burned within the last 30 days.
    ///         Computed from on-chain burn records — no indexer needed.
    function getBurnedThisMonth() external view returns (uint256 burned) {
        uint256 len = _burnHistory.length;
        if (len == 0) return 0;

        uint256 monthStart = block.timestamp - 30 days;

        for (uint256 i = 0; i < len; i++) {
            if (_burnHistory[i].timestamp >= monthStart) {
                burned += _burnHistory[i].amount;
            }
        }
    }

    /// @dev Internal helper: record a burn and update totalBurned.
    function _recordBurn(
        address burner,
        uint256 amount,
        string memory burnType
    ) internal {
        totalBurned += amount;
        _burnHistory.push(
            BurnRecord({
                burner: burner,
                amount: amount,
                timestamp: block.timestamp,
                burnType: burnType
            })
        );
        emit TokensBurned(burner, amount, burnType);
    }

    // ─────────────────────────────────────────────────────────
    //                         EVENTS
    // ─────────────────────────────────────────────────────────

    event TokensPurchased(
        address indexed buyer,
        uint256 usdtAmount,
        uint256 tokensReceived
    );
    event TokensIssuedForDeposit(
        address indexed user,
        uint256 usdtAmount,
        uint256 tokensReceived
    );
    event PresaleEnded();
    event MinBuyUpdated(uint256 oldMin, uint256 newMin);
    event TokensBurned(address indexed burner, uint256 amount, string burnType);

    // ─────────────────────────────────────────────────────────
    //                       CONSTRUCTOR
    // ─────────────────────────────────────────────────────────

    constructor(
        string memory name_,
        string memory symbol_,
        address liquidityAddress,
        address treasuryAddress,
        address teamAddress,
        address marketingAddress,
        address usdtAddress
    ) ERC20(name_, symbol_) Ownable(msg.sender) {
        require(liquidityAddress != address(0), "Liquidity addr zero");
        require(treasuryAddress != address(0), "Treasury addr zero");
        require(teamAddress != address(0), "Team addr zero");
        require(marketingAddress != address(0), "Marketing addr zero");
        require(usdtAddress != address(0), "USDT addr zero");

        USDT = IERC20(usdtAddress);

        // Mint full supply to this contract, then distribute the non-presale parts.
        _mint(address(this), TOTAL_SUPPLY);

        _transfer(address(this), liquidityAddress, LIQUIDITY_SUPPLY);
        _transfer(address(this), treasuryAddress, TREASURY_SUPPLY);
        _transfer(address(this), teamAddress, TEAM_SUPPLY);
        _transfer(address(this), marketingAddress, MARKETING_SUPPLY);
    }

    // ─────────────────────────────────────────────────────────
    //                     ADMIN FUNCTIONS
    // ─────────────────────────────────────────────────────────

    function endPresale() external onlyOwner {
        presaleActive = false;
        emit PresaleEnded();
    }

    // ─────────────────────────────────────────────────────────
    //                       BUY FUNCTION
    // ─────────────────────────────────────────────────────────

    modifier onlyWhileActive() {
        require(presaleActive, "Presale has ended");
        _;
    }

    /**
     * @notice Buy presale tokens with USDT directly from the presale contract.
     *
     *         The USDT paid here is forwarded to the VaultContract so the buyer's
     *         funds immediately start earning ROI — no separate deposit call needed.
     *
     *         Flow:
     *           1. User approves this contract for `amount` USDT.
     *           2. Presale pulls USDT from user.
     *           3. Presale issues tokens to user.
     *           4. Presale forwards USDT to VaultContract and records the deposit
     *              by calling vault.recordDepositFrom(user, amount).
     *
     * @param  amount  USDT amount (6 decimals) to spend.
     */
    function buy(uint256 amount) external nonReentrant onlyWhileActive {
        require(amount >= minBuy, "Below minimum buy amount");
        require(totalRaised + amount <= HARD_CAP, "Hard cap reached");
        require(vaultContract != address(0), "Vault not linked yet");

        // Pull USDT from buyer into this contract
        USDT.safeTransferFrom(msg.sender, address(this), amount);
        totalRaised += amount;

        // Issue presale tokens to buyer
        uint256 tokensToSend = _usdtToTokens(amount);
        require(
            remainingPresaleTokens() >= tokensToSend,
            "Presale supply exhausted"
        );
        _transfer(address(this), msg.sender, tokensToSend);
        emit TokensPurchased(msg.sender, amount, tokensToSend);

        // Forward USDT to vault and record the deposit so ROI starts immediately
        USDT.safeTransfer(vaultContract, amount);
        IVaultContract(vaultContract).recordDepositFrom(msg.sender, amount);

        // Auto-end presale if hard cap hit
        if (totalRaised >= HARD_CAP) {
            presaleActive = false;
            emit PresaleEnded();
        }
    }

    // ─────────────────────────────────────────────────────────
    //          VAULT-ONLY: ISSUE TOKENS FOR A DEPOSIT
    // ─────────────────────────────────────────────────────────

    function issueTokensForDeposit(
        address user,
        uint256 usdtAmount
    ) external onlyVault {
        require(presaleActive, "Presale has ended");
        require(totalRaised + usdtAmount <= HARD_CAP, "Hard cap reached");

        totalRaised += usdtAmount;

        uint256 tokensOut = _usdtToTokens(usdtAmount);
        require(
            remainingPresaleTokens() >= tokensOut,
            "Presale supply exhausted"
        );

        _transfer(address(this), user, tokensOut);
        emit TokensIssuedForDeposit(user, usdtAmount, tokensOut);

        if (totalRaised >= HARD_CAP) {
            presaleActive = false;
            emit PresaleEnded();
        }
    }

    /// @notice Burns a chosen `amount` of unsold presale tokens from this contract.
    ///         Call `remainingPresaleTokens()` first to see the maximum burnable amount.
    ///
    /// @param  amount  Token amount (18 decimals) to burn. Must be > 0 and
    ///                 <= remainingPresaleTokens().
    function burnUnsoldTokens(uint256 amount) external onlyOwner {
        require(!presaleActive, "Presale still active");
        require(amount > 0, "Amount must be > 0");

        uint256 unsold = remainingPresaleTokens();

        require(unsold > 0, "No unsold presale tokens");
        require(amount <= unsold, "Amount exceeds unsold tokens");

        _recordBurn(address(this), amount, "UNSOLD");
        _burn(address(this), amount);
    }

    // ─────────────────────────────────────────────────────────
    //              USER BURN OVERRIDES (with tracking)
    // ─────────────────────────────────────────────────────────

    /// @notice Burn `amount` tokens from caller's own wallet.
    ///         Recorded in burn history with type "USER".
    function burn(uint256 amount) public override {
        _recordBurn(msg.sender, amount, "USER");
        super.burn(amount);
    }

    /// @notice Burn `amount` tokens from `account` (requires allowance).
    ///         Recorded in burn history with type "APPROVED".
    function burnFrom(address account, uint256 amount) public override {
        _recordBurn(account, amount, "APPROVED");
        super.burnFrom(account, amount);
    }

    // ─────────────────────────────────────────────────────────
    //                      VIEW HELPERS
    // ─────────────────────────────────────────────────────────

    function previewPurchase(uint256 amount) external pure returns (uint256) {
        return _usdtToTokens(amount);
    }

    function remainingCap() external view returns (uint256) {
        return HARD_CAP - totalRaised;
    }

    function remainingPresaleTokens() public view returns (uint256) {
        return balanceOf(address(this));
    }

    // ─────────────────────────────────────────────────────────
    //                    INTERNAL HELPERS
    // ─────────────────────────────────────────────────────────

    /// @dev Convert USDT (6 dec) → project tokens (18 dec) at presale price.
    function _usdtToTokens(uint256 usdtAmount) internal pure returns (uint256) {
        return (usdtAmount * 1e18) / PRICE_IN_USDT;
    }

    // ─────────────────────────────────────────────────────────
    //                    INTERNAL OVERRIDE
    // ─────────────────────────────────────────────────────────

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20) {
        super._update(from, to, value);
    }
}

// ─────────────────────────────────────────────────────────────
//   Interface used by ProjectTokenPresale to call VaultContract
// ─────────────────────────────────────────────────────────────

interface IVaultContract {
    /**
     * @notice Called by the presale after forwarding USDT to the vault.
     *         Records a vault deposit on behalf of `user` so ROI starts immediately.
     *         Only callable by the linked presale contract.
     */
    function recordDepositFrom(address user, uint256 amount) external;
}
