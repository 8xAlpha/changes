// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IProjectTokenPresale {
    function issueTokensForDeposit(address user, uint256 usdtAmount) external;

    function presaleActive() external view returns (bool);
}

/**
 * @title  VaultContractV2
 * @notice Same product as VaultContract (v1): users deposit USDT (directly or through the
 *         presale), the owner takes the pooled principal out to trade, and the profit is paid
 *         back to depositors. What changes:
 *
 *         - Profit is sent on its own with `distributeProfit`. No principal round trip.
 *           Every active deposit can claim its share at any time, and claims don't depend on
 *           the order of distributions, so a period without profit can't block later claims.
 *         - Principal is tracked separately. The owner takes it out with `ownerWithdraw`
 *           (this opens a cycle) and brings it back with `ownerReturnPrincipal`. The cycle
 *           closes once all of it is back, or when the shortfall is written off with
 *           `ownerCloseCycleWithLoss`. Users can withdraw principal only while no cycle is
 *           open, and only for a deposit that has been through at least one cycle (as in v1),
 *           so a deposit can never be refunded before it has taken part in a cycle.
 *         - A loss is shared pro rata by the active deposits instead of going unrecorded.
 *         - The owner can't withdraw users' unclaimed profit or deposits that haven't joined
 *           a cycle yet.
 *
 *         Deposits wait as "pending" until the next `ownerWithdraw` (or
 *         `activatePendingDeposits`), then join the active pool and earn every later
 *         distribution.
 *
 *         Accounting uses shares. Active principal = totalShares * principalPerShare / 1e36,
 *         and a loss lowers principalPerShare. Profit uses a cumulative per-share index
 *         (accProfitPerShare). Each deposit records both values at the round it joined, so
 *         every claim is O(1) with no per-cycle loops.
 *
 *         The user-facing functions keep v1's names and ABI (deposit, withdrawProfit,
 *         withdrawPrincipal, getUserDeposits, getDepositStatus, pendingProfit,
 *         principalWithdrawEnabled) so the website can switch to this contract with little
 *         change. Deposit statuses are numbered 0-3 the way the website already expects.
 *         The cycle record keeps v1's AdminCycle layout so the admin panel can read it as-is.
 */
contract VaultContractV2 is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────
    // CONSTANTS & CONFIG
    // ─────────────────────────────────────────────────────────────

    uint256 public constant BASIS_POINTS = 10_000;
    uint256 public constant MAX_DEPOSITS_PER_WALLET = 100;
    /// @dev principalPerShare starts at 1e18. Shares carry 1e36 precision so that rounding
    ///      across many deposits leaves no meaningful unowned principal behind.
    uint256 private constant PPS_START = 1e18;
    uint256 private constant SHARE_PRECISION = 1e36;
    uint256 private constant ACC_PRECISION = 1e36;

    IERC20 public immutable USDT;
    IProjectTokenPresale public presaleContract;

    bool public paused;
    bool public principalWithdrawEnabled = true;
    uint256 public minDeposit;
    bool public migrationFinalized;

    // ─────────────────────────────────────────────────────────────
    // PRINCIPAL ACCOUNTING
    // ─────────────────────────────────────────────────────────────

    /// @notice Shares held by active deposits (those that have joined a cycle).
    uint256 public totalShares;
    /// @notice Principal per share (scaled). Starts at 1e18 and falls only on a loss.
    uint256 public principalPerShare = PPS_START;
    /// @notice Principal the owner has taken out and not yet returned. > 0 means a cycle is open.
    uint256 public deployedPrincipal;
    /// @notice Deposits waiting to join the active pool.
    uint256 public pendingPrincipal;

    // ─────────────────────────────────────────────────────────────
    // PROFIT ACCOUNTING
    // ─────────────────────────────────────────────────────────────

    /// @notice Cumulative profit per share, scaled by 1e36.
    uint256 public accProfitPerShare;
    /// @notice Distributed profit not yet claimed. The owner can never withdraw it.
    uint256 public profitReserve;
    uint256 public totalProfitDistributed;
    uint256 public totalProfitWithdrawn;
    uint256 public totalPrincipalWithdrawn;

    // ─────────────────────────────────────────────────────────────
    // ACTIVATION ROUNDS
    // ─────────────────────────────────────────────────────────────

    /// @notice Increments each time pending deposits join the active pool.
    uint256 public currentRound;
    /// @dev principalPerShare and accProfitPerShare at the moment each round activated.
    mapping(uint256 => uint256) public roundPrincipalPerShare;
    mapping(uint256 => uint256) public roundAccProfitPerShare;
    /// @notice The first cycle each round's deposits take part in: the open cycle if they join
    ///         mid-cycle, otherwise the next one to open. A deposit's principal unlocks only
    ///         once that cycle has closed.
    mapping(uint256 => uint256) public roundFirstCycle;

    // ─────────────────────────────────────────────────────────────
    // CYCLES (for display / history)
    // ─────────────────────────────────────────────────────────────

    /// @dev Same field order and names as v1's AdminCycle, so the admin panel reads it unchanged.
    struct AdminCycle {
        uint256 cycleId;
        uint256 withdrawAmount; // principal the owner took out during the cycle
        uint256 withdrawTime; // when the cycle opened
        uint256 tvlAtWithdraw; // active principal when the cycle opened
        uint256 depositAmount; // principal the owner brought back
        uint256 depositTime; // when the cycle closed (0 while open)
        uint256 profit; // profit distributed while this cycle was the latest
        uint256 roiBps; // profit / tvlAtWithdraw so far, in basis points
        bool settled; // cycle closed
    }

    uint256 public cycleCount;
    mapping(uint256 => AdminCycle) private _cycles;
    /// @notice Principal written off when a cycle closed with a loss.
    mapping(uint256 => uint256) public cycleLoss;

    struct ROIRecord {
        uint256 roi; // basis points of active principal at distribution time
        uint256 timestamp;
    }

    ROIRecord[] private _roiHistory;

    // ─────────────────────────────────────────────────────────────
    // USER DEPOSITS
    // ─────────────────────────────────────────────────────────────

    /// @dev Field order and types match v1's DepositInfo so existing frontend decoding keeps working.
    struct DepositInfo {
        uint256 amount; // USDT deposited; set to 0 once the principal is withdrawn
        uint256 startTime;
        uint256 activationRound; // round in which this deposit joins the active pool
        uint256 totalClaimed; // profit paid out so far
        bool principalWithdrawn;
        uint256 principalPaid; // principal paid out on withdrawal (after any loss)
    }

    /// @dev Numbered to match the website: 0 waiting, 1 in cycle, 2 ready, 3 withdrawn.
    enum DepositStatus {
        WaitingForCycle,
        CycleInProgress,
        ReadyToWithdraw,
        Withdrawn
    }

    mapping(address => DepositInfo[]) private _userDeposits;

    // ─────────────────────────────────────────────────────────────
    // EVENTS
    // ─────────────────────────────────────────────────────────────

    event Deposited(address indexed user, uint256 amount, uint256 activationRound);
    event DepositMigrated(address indexed user, uint256 amount, uint256 activationRound);
    event TokensIssuedOnDeposit(address indexed user, uint256 amount);
    event DepositsActivated(uint256 indexed round, uint256 principal);
    event CycleOpened(uint256 indexed cycleId, uint256 tvlAtWithdraw);
    event OwnerWithdrawn(uint256 amount, uint256 indexed cycleId);
    event PrincipalReturned(uint256 amount, uint256 indexed cycleId);
    event CycleClosed(uint256 indexed cycleId, uint256 returned, uint256 loss);
    event ProfitDistributed(uint256 amount, uint256 roiBps, uint256 indexed cycleId);
    event ProfitWithdrawn(address indexed user, uint256 amount, uint256 depositIndex);
    event PrincipalWithdrawn(address indexed user, uint256 amount, uint256 depositIndex);
    event SurplusSwept(address indexed to, uint256 amount);
    event Paused();
    event Unpaused();
    event PresaleContractSet(address indexed presale);
    event MinDepositUpdated(uint256 oldMin, uint256 newMin);
    event PrincipalWithdrawToggled(bool enabled);
    event MigrationFinalized();

    // ─────────────────────────────────────────────────────────────
    // MODIFIERS
    // ─────────────────────────────────────────────────────────────

    modifier whenNotPaused() {
        require(!paused, "Vault is paused");
        _;
    }

    // ─────────────────────────────────────────────────────────────
    // CONSTRUCTOR
    // ─────────────────────────────────────────────────────────────

    /// @param usdtAddress   USDT token.
    /// @param initialOwner  Owner from block one (e.g. a hardware wallet), independent of the deployer.
    constructor(address usdtAddress, address initialOwner) Ownable(initialOwner) {
        require(usdtAddress != address(0), "USDT addr zero");
        USDT = IERC20(usdtAddress);
    }

    // ─────────────────────────────────────────────────────────────
    // OWNER: PRINCIPAL
    // ─────────────────────────────────────────────────────────────

    /// @notice Take principal out to trade. Pending deposits join the active pool first.
    ///         Opens a cycle if none is open. Can be called again during a cycle to deploy more.
    function ownerWithdraw(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "Amount must be > 0");
        _activatePending();

        uint256 active = activePrincipal();
        require(amount <= active - deployedPrincipal, "Exceeds undeployed principal");

        if (deployedPrincipal == 0) {
            cycleCount++;
            _cycles[cycleCount] = AdminCycle({
                cycleId: cycleCount,
                withdrawAmount: 0,
                withdrawTime: block.timestamp,
                tvlAtWithdraw: active,
                depositAmount: 0,
                depositTime: 0,
                profit: 0,
                roiBps: 0,
                settled: false
            });
            emit CycleOpened(cycleCount, active);
        }

        deployedPrincipal += amount;
        _cycles[cycleCount].withdrawAmount += amount;

        USDT.safeTransfer(msg.sender, amount);
        emit OwnerWithdrawn(amount, cycleCount);
    }

    /// @notice Bring principal back. Partial returns are fine. When everything taken out has
    ///         been returned, the cycle closes and users can withdraw principal.
    function ownerReturnPrincipal(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "Amount must be > 0");
        require(amount <= deployedPrincipal, "More than deployed; send profit with distributeProfit");

        USDT.safeTransferFrom(msg.sender, address(this), amount);

        deployedPrincipal -= amount;
        _cycles[cycleCount].depositAmount += amount;
        emit PrincipalReturned(amount, cycleCount);

        if (deployedPrincipal == 0) {
            _closeCycle(0);
        }
    }

    /// @notice Close the cycle when not all principal can be returned. Sends `amountReturned`
    ///         (may be 0) and writes off the rest of the deployed principal as a loss, shared pro
    ///         rata by active deposits. Pending deposits are unaffected.
    /// @dev    At least 1 unit of active principal must remain (return at least 1 unit if
    ///         everything that was deployed is lost).
    function ownerCloseCycleWithLoss(uint256 amountReturned) external onlyOwner nonReentrant {
        require(deployedPrincipal > 0, "No open cycle");
        require(amountReturned < deployedPrincipal, "No loss; use ownerReturnPrincipal");

        if (amountReturned > 0) {
            USDT.safeTransferFrom(msg.sender, address(this), amountReturned);
            _cycles[cycleCount].depositAmount += amountReturned;
            emit PrincipalReturned(amountReturned, cycleCount);
        }

        uint256 loss = deployedPrincipal - amountReturned;
        uint256 active = activePrincipal();
        require(loss < active, "Loss would wipe out all principal");

        principalPerShare = (principalPerShare * (active - loss)) / active;
        require(principalPerShare > 0, "Principal per share underflow");

        deployedPrincipal = 0;
        _closeCycle(loss);
    }

    function _closeCycle(uint256 loss) internal {
        AdminCycle storage c = _cycles[cycleCount];
        cycleLoss[cycleCount] = loss;
        c.depositTime = block.timestamp;
        c.settled = true;
        emit CycleClosed(cycleCount, c.depositAmount, loss);
    }

    /// @notice Let pending deposits start earning without taking any principal out.
    function activatePendingDeposits() external onlyOwner nonReentrant {
        require(pendingPrincipal > 0, "No pending deposits");
        _activatePending();
    }

    function _activatePending() internal {
        uint256 pending = pendingPrincipal;
        if (pending == 0) return;

        uint256 round = currentRound + 1;
        roundPrincipalPerShare[round] = principalPerShare;
        roundAccProfitPerShare[round] = accProfitPerShare;
        roundFirstCycle[round] = deployedPrincipal > 0 ? cycleCount : cycleCount + 1;
        totalShares += (pending * SHARE_PRECISION) / principalPerShare;
        currentRound = round;
        pendingPrincipal = 0;

        emit DepositsActivated(round, pending);
    }

    // ─────────────────────────────────────────────────────────────
    // OWNER: PROFIT
    // ─────────────────────────────────────────────────────────────

    /// @notice Send profit to be shared by all active deposits, pro rata to their principal.
    ///         Claimable right away. Can be called any time, with or without an open cycle.
    function distributeProfit(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "Amount must be > 0");
        uint256 shares = totalShares;
        require(shares > 0, "No active deposits");

        uint256 increment = (amount * ACC_PRECISION) / shares;
        require(increment > 0, "Amount too small to distribute");

        USDT.safeTransferFrom(msg.sender, address(this), amount);

        accProfitPerShare += increment;
        profitReserve += amount;
        totalProfitDistributed += amount;

        uint256 active = activePrincipal();
        uint256 roiBps = active > 0 ? (amount * BASIS_POINTS) / active : 0;
        _roiHistory.push(ROIRecord({roi: roiBps, timestamp: block.timestamp}));
        if (cycleCount > 0) {
            AdminCycle storage c = _cycles[cycleCount];
            c.profit += amount;
            if (c.tvlAtWithdraw > 0) {
                c.roiBps = (c.profit * BASIS_POINTS) / c.tvlAtWithdraw;
            }
        }

        emit ProfitDistributed(amount, roiBps, cycleCount);
    }

    // ─────────────────────────────────────────────────────────────
    // OWNER: SETTINGS
    // ─────────────────────────────────────────────────────────────

    function pause() external onlyOwner {
        require(!paused, "Vault is paused");
        paused = true;
        emit Paused();
    }

    function unpause() external onlyOwner {
        require(paused, "Vault is not paused");
        paused = false;
        emit Unpaused();
    }

    function togglePrincipalWithdraw() external onlyOwner {
        principalWithdrawEnabled = !principalWithdrawEnabled;
        emit PrincipalWithdrawToggled(principalWithdrawEnabled);
    }

    function setMinDeposit(uint256 _min) external onlyOwner {
        emit MinDepositUpdated(minDeposit, _min);
        minDeposit = _min;
    }

    function setPresaleContract(address _presale) external onlyOwner {
        require(_presale != address(0), "Zero address");
        require(_presale.code.length > 0, "Not a contract");
        require(_presale != address(presaleContract), "Same address");
        presaleContract = IProjectTokenPresale(_presale);
        emit PresaleContractSet(_presale);
    }

    /// @notice Send USDT that belongs to nobody (direct transfers, rounding dust) to the owner.
    ///         Never touches principal, pending deposits or unclaimed profit.
    function sweepSurplus() external onlyOwner nonReentrant {
        uint256 amount = surplus();
        require(amount > 0, "No surplus");
        USDT.safeTransfer(msg.sender, amount);
        emit SurplusSwept(msg.sender, amount);
    }

    /// @notice One-time move of positions from the v1 vault: pulls the total from the owner and
    ///         records each amount as a pending deposit for its user (no presale tokens issued).
    function migrateDeposits(
        address[] calldata users,
        uint256[] calldata amounts
    ) external onlyOwner nonReentrant {
        require(!migrationFinalized, "Migration finalized");
        require(users.length == amounts.length, "Length mismatch");

        uint256 total;
        for (uint256 i = 0; i < amounts.length; i++) {
            total += amounts[i];
        }
        require(total > 0, "Nothing to migrate");

        USDT.safeTransferFrom(msg.sender, address(this), total);

        for (uint256 i = 0; i < users.length; i++) {
            require(users[i] != address(0), "Zero user address");
            require(amounts[i] > 0, "Amount must be > 0");
            _recordDeposit(users[i], amounts[i]);
            emit DepositMigrated(users[i], amounts[i], currentRound + 1);
        }
    }

    function finalizeMigration() external onlyOwner {
        require(!migrationFinalized, "Migration finalized");
        migrationFinalized = true;
        emit MigrationFinalized();
    }

    /// @dev Renouncing would leave deployed principal with no way back into the vault.
    function renounceOwnership() public view override onlyOwner {
        revert("Renounce disabled");
    }

    // ─────────────────────────────────────────────────────────────
    // USER: DEPOSIT
    // ─────────────────────────────────────────────────────────────

    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be > 0");
        require(amount >= minDeposit, "Below minimum deposit amount");

        USDT.safeTransferFrom(msg.sender, address(this), amount);
        _recordDeposit(msg.sender, amount);
        _tryIssueTokens(msg.sender, amount);
    }

    /// @notice Called by the presale after it has forwarded `amount` USDT to this vault.
    function recordDepositFrom(address user, uint256 amount) external nonReentrant whenNotPaused {
        require(msg.sender == address(presaleContract), "Caller is not the presale");
        require(user != address(0), "Zero user address");
        require(amount > 0, "Amount must be > 0");
        require(
            USDT.balanceOf(address(this)) >= _accountedBalance() + amount,
            "USDT not received"
        );
        _recordDeposit(user, amount);
    }

    function _recordDeposit(address user, uint256 amount) internal {
        require(
            _userDeposits[user].length < MAX_DEPOSITS_PER_WALLET,
            "Max 100 deposits per wallet"
        );

        uint256 round = currentRound + 1;
        _userDeposits[user].push(
            DepositInfo({
                amount: amount,
                startTime: block.timestamp,
                activationRound: round,
                totalClaimed: 0,
                principalWithdrawn: false,
                principalPaid: 0
            })
        );
        pendingPrincipal += amount;

        emit Deposited(user, amount, round);
    }

    function _tryIssueTokens(address user, uint256 amount) internal {
        if (address(presaleContract) == address(0)) return;
        try presaleContract.presaleActive() returns (bool active) {
            if (!active) return;
        } catch {
            return;
        }
        try presaleContract.issueTokensForDeposit(user, amount) {
            emit TokensIssuedOnDeposit(user, amount);
        } catch {}
    }

    // ─────────────────────────────────────────────────────────────
    // USER: WITHDRAW
    // ─────────────────────────────────────────────────────────────

    /// @notice Claim all profit earned so far by one deposit.
    function withdrawProfit(uint256 depositIndex) external nonReentrant whenNotPaused {
        DepositInfo storage d = _deposit(msg.sender, depositIndex);
        uint256 profit = _claimable(d);
        require(profit > 0, "No profit to withdraw");

        _payProfit(d, profit);
        USDT.safeTransfer(msg.sender, profit);
        emit ProfitWithdrawn(msg.sender, profit, depositIndex);
    }

    /// @notice Claim the profit of every deposit in one transaction.
    function withdrawAllProfit() external nonReentrant whenNotPaused {
        DepositInfo[] storage list = _userDeposits[msg.sender];
        uint256 total;
        for (uint256 i = 0; i < list.length; i++) {
            uint256 profit = _claimable(list[i]);
            if (profit == 0) continue;
            _payProfit(list[i], profit);
            total += profit;
            emit ProfitWithdrawn(msg.sender, profit, i);
        }
        require(total > 0, "No profit to withdraw");
        USDT.safeTransfer(msg.sender, total);
    }

    /// @notice Withdraw a deposit's principal, together with any unclaimed profit.
    ///         Allowed only while no cycle is open (the owner has returned all deployed
    ///         principal or closed the cycle with a loss), and only for a deposit that has been
    ///         through at least one cycle: it joined the pool and that cycle has since closed.
    ///         A deposit can therefore never be refunded before it has taken part in a cycle,
    ///         which rules out buy-and-refund of presale tokens, including within one transaction.
    function withdrawPrincipal(uint256 depositIndex) external nonReentrant whenNotPaused {
        require(principalWithdrawEnabled, "Principal withdrawal is currently disabled");
        DepositInfo storage d = _deposit(msg.sender, depositIndex);
        require(!d.principalWithdrawn, "Already withdrawn");
        require(
            deployedPrincipal == 0,
            "Principal is deployed in an open cycle, wait for it to be returned"
        );
        require(
            _completedCycle(d),
            "Deposit must complete a cycle before its principal can be withdrawn"
        );

        uint256 shares = _sharesOf(d);
        uint256 principal = (shares * principalPerShare) / SHARE_PRECISION;
        uint256 profit = _claimable(d);
        totalShares -= shares;
        if (profit > 0) {
            _payProfit(d, profit);
            emit ProfitWithdrawn(msg.sender, profit, depositIndex);
        }

        d.principalWithdrawn = true;
        d.principalPaid = principal;
        d.amount = 0;
        totalPrincipalWithdrawn += principal;

        uint256 payout = principal + profit;
        if (payout > 0) {
            USDT.safeTransfer(msg.sender, payout);
        }
        emit PrincipalWithdrawn(msg.sender, principal, depositIndex);
    }

    function _payProfit(DepositInfo storage d, uint256 profit) internal {
        d.totalClaimed += profit;
        profitReserve = profitReserve >= profit ? profitReserve - profit : 0;
        totalProfitWithdrawn += profit;
    }

    // ─────────────────────────────────────────────────────────────
    // INTERNAL VIEWS
    // ─────────────────────────────────────────────────────────────

    function _deposit(address user, uint256 index) internal view returns (DepositInfo storage) {
        require(index < _userDeposits[user].length, "No such deposit");
        return _userDeposits[user][index];
    }

    function _isActive(DepositInfo storage d) internal view returns (bool) {
        return !d.principalWithdrawn && d.activationRound <= currentRound;
    }

    /// @dev The deposit has joined the pool and its first cycle has opened. Combined with
    ///      "no cycle open now", that cycle has also closed.
    function _completedCycle(DepositInfo storage d) internal view returns (bool) {
        return
            d.activationRound <= currentRound &&
            roundFirstCycle[d.activationRound] <= cycleCount;
    }

    function _sharesOf(DepositInfo storage d) internal view returns (uint256) {
        return (d.amount * SHARE_PRECISION) / roundPrincipalPerShare[d.activationRound];
    }

    function _claimable(DepositInfo storage d) internal view returns (uint256) {
        if (!_isActive(d)) return 0;
        uint256 earned = (_sharesOf(d) *
            (accProfitPerShare - roundAccProfitPerShare[d.activationRound])) / ACC_PRECISION;
        return earned > d.totalClaimed ? earned - d.totalClaimed : 0;
    }

    /// @dev USDT the vault owes someone: undeployed active principal, pending deposits, unclaimed profit.
    function _accountedBalance() internal view returns (uint256) {
        return (activePrincipal() - deployedPrincipal) + pendingPrincipal + profitReserve;
    }

    // ─────────────────────────────────────────────────────────────
    // VIEWS: POOL
    // ─────────────────────────────────────────────────────────────

    /// @notice Principal of all active deposits, after any loss (deployed or not).
    function activePrincipal() public view returns (uint256) {
        return (totalShares * principalPerShare) / SHARE_PRECISION;
    }

    /// @notice Active + pending principal.
    function totalValueLocked() external view returns (uint256) {
        return activePrincipal() + pendingPrincipal;
    }

    function isCycleOpen() public view returns (bool) {
        return deployedPrincipal > 0;
    }

    /// @notice The most `ownerWithdraw` accepts right now (pending deposits included, since
    ///         `ownerWithdraw` activates them first).
    function ownerWithdrawable() external view returns (uint256) {
        uint256 shares = totalShares;
        if (pendingPrincipal > 0) {
            shares += (pendingPrincipal * SHARE_PRECISION) / principalPerShare;
        }
        return (shares * principalPerShare) / SHARE_PRECISION - deployedPrincipal;
    }

    /// @notice USDT in the vault that belongs to nobody (direct transfers, rounding dust).
    function surplus() public view returns (uint256) {
        uint256 bal = USDT.balanceOf(address(this));
        uint256 owed = _accountedBalance();
        return bal > owed ? bal - owed : 0;
    }

    function getCycle(uint256 cycleId) external view returns (AdminCycle memory) {
        return _cycles[cycleId];
    }

    function getCurrentCycle() external view returns (AdminCycle memory) {
        return _cycles[cycleCount];
    }

    function getROIHistory() external view returns (ROIRecord[] memory) {
        return _roiHistory;
    }

    // ─────────────────────────────────────────────────────────────
    // VIEWS: USER (same names and ABI as v1)
    // ─────────────────────────────────────────────────────────────

    function getUserDeposits(address user) external view returns (DepositInfo[] memory) {
        return _userDeposits[user];
    }

    function getDepositStatus(
        address user,
        uint256 depositIndex
    ) external view returns (DepositStatus) {
        DepositInfo storage d = _deposit(user, depositIndex);
        if (d.principalWithdrawn) return DepositStatus.Withdrawn;
        if (d.activationRound > currentRound) return DepositStatus.WaitingForCycle; // not joined yet
        if (deployedPrincipal > 0) return DepositStatus.CycleInProgress;
        if (!_completedCycle(d)) return DepositStatus.WaitingForCycle; // joined, first cycle not started
        return DepositStatus.ReadyToWithdraw;
    }

    /// @notice True when withdrawPrincipal would be allowed for this deposit (ignoring pause).
    function isDepositUnlocked(address user, uint256 depositIndex) external view returns (bool) {
        DepositInfo storage d = _deposit(user, depositIndex);
        if (d.principalWithdrawn || !principalWithdrawEnabled) return false;
        return deployedPrincipal == 0 && _completedCycle(d);
    }

    /// @notice Profit this deposit can claim right now.
    function pendingProfit(address user, uint256 depositIndex) public view returns (uint256) {
        return _claimable(_deposit(user, depositIndex));
    }

    /// @notice Same as pendingProfit (kept for v1 compatibility).
    function totalPendingProfit(address user, uint256 depositIndex) external view returns (uint256) {
        return pendingProfit(user, depositIndex);
    }

    /// @notice Profit claimable across all of a user's deposits.
    function claimableProfitOf(address user) external view returns (uint256 total) {
        DepositInfo[] storage list = _userDeposits[user];
        for (uint256 i = 0; i < list.length; i++) {
            total += _claimable(list[i]);
        }
    }

    /// @notice Principal this deposit would receive today (after any loss).
    function principalOf(address user, uint256 depositIndex) external view returns (uint256) {
        DepositInfo storage d = _deposit(user, depositIndex);
        if (d.principalWithdrawn) return 0;
        if (d.activationRound > currentRound) return d.amount;
        return (_sharesOf(d) * principalPerShare) / SHARE_PRECISION;
    }
}
