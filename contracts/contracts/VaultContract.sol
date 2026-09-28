pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IProjectTokenPresale {
    function issueTokensForDeposit(address user, uint256 usdtAmount) external;
    function presaleActive() external view returns (bool);
}

contract VaultContract is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDT;

    bool public paused;

    modifier whenNotPaused() {
        require(!paused, "Vault is paused");
        _;
    }

    modifier whenPaused() {
        require(paused, "Vault is not paused");
        _;
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused();
    }

    function unpause() external onlyOwner whenPaused {
        paused = false;
        emit Unpaused();
    }

    struct AdminCycle {
        uint256 cycleId;
        uint256 withdrawAmount;
        uint256 withdrawTime;
        uint256 tvlAtWithdraw;
        uint256 depositAmount;
        uint256 depositTime;
        uint256 profit;
        uint256 roiBps;
        bool settled;
    }

    uint256 public adminCycleCount;
    mapping(uint256 => AdminCycle) public adminCycles;
    uint256 public currentCycleId;

    struct ROIRecord {
        uint256 roi;
        uint256 timestamp;
    }

    ROIRecord[] public roiHistory;

    function getROIHistory() external view returns (ROIRecord[] memory) {
        return roiHistory;
    }

    struct DepositInfo {
        uint256 amount;
        uint256 startTime;
        uint256 assignedCycleId;
        uint256 totalClaimed;
        bool    principalWithdrawn;
        uint256 lastClaimedCycleId;
    }

    struct TxRecord {
        uint256 amount;
        uint256 timestamp;
    }

    mapping(address => DepositInfo[]) public userDeposits;
    mapping(address => TxRecord[])    public depositHistory;
    mapping(address => TxRecord[])    public profitWithdrawHistory;
    mapping(address => TxRecord[])    public principalWithdrawHistory;

    TxRecord[] public ownerDepositHistory;
    TxRecord[] public ownerWithdrawHistory;

    uint256 public totalDeposited;
    uint256 public totalPrincipalWithdrawn;
    uint256 public totalProfitWithdrawn;

    uint256 public pendingDeposits;
    mapping(uint256 => uint256) public cycleAssignedDeposits;

    uint256 public constant BASIS_POINTS = 10_000;

    bool public principalWithdrawEnabled = true;

    function togglePrincipalWithdraw() external onlyOwner {
        principalWithdrawEnabled = !principalWithdrawEnabled;
        emit PrincipalWithdrawToggled(principalWithdrawEnabled);
    }

    uint256 public minDeposit = 0;

    function setMinDeposit(uint256 _min) external onlyOwner {
        emit MinDepositUpdated(minDeposit, _min);
        minDeposit = _min;
    }

    IProjectTokenPresale public presaleContract;

    function setPresaleContract(address _presale) external onlyOwner {
        require(_presale != address(0), "Zero address");
        require(_presale.code.length > 0, "Not a contract");
        require(_presale != address(presaleContract), "Same address");
        presaleContract = IProjectTokenPresale(_presale);
        emit PresaleContractSet(_presale);
    }

    mapping(address => bool) public moderators;

    modifier onlyModerator() {
        require(
            moderators[msg.sender] || owner() == msg.sender,
            "Not authorized"
        );
        _;
    }

    function addModerator(address _mod) external onlyOwner {
        require(_mod != address(0), "Zero address");
        moderators[_mod] = true;
        emit ModeratorAdded(_mod);
    }

    function removeModerator(address _mod) external onlyOwner {
        require(moderators[_mod], "Not a moderator");
        moderators[_mod] = false;
        emit ModeratorRemoved(_mod);
    }

    event ROIUpdated(uint256 oldROI, uint256 newROI);
    event Deposited(address indexed user, uint256 amount, uint256 assignedCycleId);
    event TokensIssuedOnDeposit(address indexed user, uint256 amount);
    event ProfitWithdrawn(address indexed user, uint256 amount, uint256 cycleId);
    event PrincipalWithdrawn(address indexed user, uint256 amount, uint256 cycleId);
    event CycleOpened(uint256 indexed cycleId, uint256 withdrawAmount, uint256 tvlSnapshot);
    event CycleSettled(uint256 indexed cycleId, uint256 depositAmount, uint256 profit, uint256 roiBps);
    event OwnerDeposited(uint256 amount, uint256 cycleId);
    event OwnerWithdrawn(uint256 amount, uint256 cycleId);
    event Paused();
    event Unpaused();
    event PresaleContractSet(address indexed presale);
    event MinDepositUpdated(uint256 oldMin, uint256 newMin);
    event ModeratorAdded(address indexed mod);
    event ModeratorRemoved(address indexed mod);
    event PrincipalWithdrawToggled(bool enabled);

    constructor(address usdtAddress) Ownable(msg.sender) {
        require(usdtAddress != address(0), "USDT addr zero");
        USDT = IERC20(usdtAddress);
        paused = false;
    }

    function ownerWithdraw(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "Amount must be > 0");
        require(
            USDT.balanceOf(address(this)) >= amount,
            "Insufficient vault balance"
        );

        if (currentCycleId > 0) {
            require(
                adminCycles[currentCycleId].settled,
                "Previous cycle not settled yet"
            );
        }

        adminCycleCount++;
        currentCycleId = adminCycleCount;

        uint256 newlyEligible = cycleAssignedDeposits[currentCycleId];
        if (pendingDeposits >= newlyEligible) {
            pendingDeposits -= newlyEligible;
        } else {
            pendingDeposits = 0;
        }

        uint256 eligibleTVL = totalDeposited - pendingDeposits;

        adminCycles[currentCycleId] = AdminCycle({
            cycleId:        currentCycleId,
            withdrawAmount: amount,
            withdrawTime:   block.timestamp,
            tvlAtWithdraw:  eligibleTVL,
            depositAmount:  0,
            depositTime:    0,
            profit:         0,
            roiBps:         0,
            settled:        false
        });

        USDT.safeTransfer(owner(), amount);

        ownerWithdrawHistory.push(
            TxRecord({amount: amount, timestamp: block.timestamp})
        );

        emit CycleOpened(currentCycleId, amount, eligibleTVL);
        emit OwnerWithdrawn(amount, currentCycleId);
    }

    function ownerDeposit(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "Amount must be > 0");
        require(currentCycleId > 0, "No open cycle, call ownerWithdraw first");

        AdminCycle storage c = adminCycles[currentCycleId];
        require(!c.settled, "Cycle already settled");

        USDT.safeTransferFrom(msg.sender, address(this), amount);

        c.depositAmount = amount;
        c.depositTime   = block.timestamp;

        uint256 profit = 0;
        if (amount > c.withdrawAmount) {
            profit = amount - c.withdrawAmount;
        }
        uint256 tvl = c.tvlAtWithdraw;

        if (tvl > 0 && profit > 0) {
            c.roiBps = (profit * BASIS_POINTS) / tvl;
        } else {
            c.roiBps = 0;
        }

        c.profit  = profit;
        c.settled = true;

        uint256 oldROI = roiHistory.length > 0
            ? roiHistory[roiHistory.length - 1].roi
            : 0;

        roiHistory.push(ROIRecord({
            roi:       c.roiBps,
            timestamp: block.timestamp
        }));

        emit ROIUpdated(oldROI, c.roiBps);

        ownerDepositHistory.push(
            TxRecord({amount: amount, timestamp: block.timestamp})
        );

        emit CycleSettled(currentCycleId, amount, profit, c.roiBps);
        emit OwnerDeposited(amount, currentCycleId);
    }

    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        require(userDeposits[msg.sender].length < 100, "Max 100 deposits per wallet");
        require(amount >= minDeposit, "Below minimum deposit amount");
        require(amount > 0, "Amount must be > 0");

        USDT.safeTransferFrom(msg.sender, address(this), amount);
        _recordDeposit(msg.sender, amount);
        _tryIssueTokens(msg.sender, amount);
    }

    function recordDepositFrom(
        address user,
        uint256 amount
    ) external nonReentrant whenNotPaused {
        require(msg.sender == address(presaleContract), "Caller is not the presale");
        require(user != address(0), "Zero user address");
        require(userDeposits[user].length < 100, "Max 100 deposits per wallet");
        require(amount > 0, "Amount must be > 0");
        _recordDeposit(user, amount);
    }

    function _recordDeposit(address user, uint256 amount) internal {
        uint256 waitingForCycle = currentCycleId + 1;

        userDeposits[user].push(DepositInfo({
            amount:             amount,
            startTime:          block.timestamp,
            assignedCycleId:    waitingForCycle,
            totalClaimed:       0,
            principalWithdrawn: false,
            lastClaimedCycleId: waitingForCycle - 1
        }));

        depositHistory[user].push(
            TxRecord({amount: amount, timestamp: block.timestamp})
        );

        totalDeposited += amount;

        cycleAssignedDeposits[waitingForCycle] += amount;
        pendingDeposits += amount;

        emit Deposited(user, amount, waitingForCycle);
    }

    function _tryIssueTokens(address user, uint256 amount) internal {
        if (address(presaleContract) == address(0)) return;
        try presaleContract.presaleActive() returns (bool active) {
            if (!active) return;
        } catch { return; }
        try presaleContract.issueTokensForDeposit(user, amount) {
            emit TokensIssuedOnDeposit(user, amount);
        } catch {}
    }

    function withdrawProfit(
        uint256 depositIndex
    ) external nonReentrant whenNotPaused {
        DepositInfo storage d = userDeposits[msg.sender][depositIndex];

        require(d.amount > 0,          "No active deposit");
        require(!d.principalWithdrawn, "Principal already withdrawn");

        uint256 nextCycle = d.lastClaimedCycleId + 1;

        require(
            nextCycle >= d.assignedCycleId,
            "Deposit not yet eligible for this cycle"
        );

        AdminCycle memory c = adminCycles[nextCycle];

        require(
            c.settled,
            "Cycle not settled yet, wait for admin to deposit profit"
        );
        require(c.roiBps > 0, "No profit generated in this cycle");

        uint256 profit = (d.amount * c.roiBps) / BASIS_POINTS;
        require(profit > 0, "Profit rounds to zero");
        require(
            USDT.balanceOf(address(this)) >= profit,
            "Insufficient vault liquidity"
        );

        d.totalClaimed       += profit;
        d.lastClaimedCycleId  = nextCycle;

        USDT.safeTransfer(msg.sender, profit);

        profitWithdrawHistory[msg.sender].push(
            TxRecord({amount: profit, timestamp: block.timestamp})
        );
        totalProfitWithdrawn += profit;

        emit ProfitWithdrawn(msg.sender, profit, nextCycle);
    }

    function withdrawPrincipal(
        uint256 depositIndex
    ) external nonReentrant whenNotPaused {
        require(principalWithdrawEnabled, "Principal withdrawal is currently disabled");

        DepositInfo storage d = userDeposits[msg.sender][depositIndex];

        require(d.amount > 0,          "No active deposit");
        require(!d.principalWithdrawn, "Already withdrawn");

        AdminCycle memory assigned = adminCycles[d.assignedCycleId];
        require(
            assigned.settled,
            "Your assigned cycle not settled yet, wait for admin"
        );

        require(
            adminCycles[currentCycleId].settled,
            "New cycle in progress, your principal is locked until it settles"
        );

        uint256 principal = d.amount;

        uint256 totalProfit = 0;
        for (uint256 cid = d.lastClaimedCycleId + 1; cid <= currentCycleId; cid++) {
            AdminCycle memory c = adminCycles[cid];
            if (!c.settled) break;
            if (cid < d.assignedCycleId) continue;
            if (c.roiBps == 0) continue;
            totalProfit += (principal * c.roiBps) / BASIS_POINTS;
        }

        uint256 totalOut = principal + totalProfit;
        require(
            USDT.balanceOf(address(this)) >= totalOut,
            "Insufficient vault liquidity"
        );

        d.amount             = 0;
        d.principalWithdrawn = true;
        d.lastClaimedCycleId = currentCycleId;
        totalDeposited      -= principal;

        if (d.assignedCycleId > currentCycleId) {
            if (pendingDeposits >= principal) {
                pendingDeposits -= principal;
            } else {
                pendingDeposits = 0;
            }
            if (cycleAssignedDeposits[d.assignedCycleId] >= principal) {
                cycleAssignedDeposits[d.assignedCycleId] -= principal;
            }
        }
        if (totalProfit > 0) {
            d.totalClaimed       += totalProfit;
            totalProfitWithdrawn += totalProfit;
            USDT.safeTransfer(msg.sender, totalProfit);
            profitWithdrawHistory[msg.sender].push(
                TxRecord({amount: totalProfit, timestamp: block.timestamp})
            );
            emit ProfitWithdrawn(msg.sender, totalProfit, currentCycleId);
        }

        USDT.safeTransfer(msg.sender, principal);
        principalWithdrawHistory[msg.sender].push(
            TxRecord({amount: principal, timestamp: block.timestamp})
        );
        totalPrincipalWithdrawn += principal;

        emit PrincipalWithdrawn(msg.sender, principal, d.assignedCycleId);
    }

    enum DepositStatus {
        WaitingForCycle,
        CycleInProgress,
        LockedInNewCycle,
        ReadyToWithdraw,
        Withdrawn
    }

    function getDepositStatus(
        address user,
        uint256 depositIndex
    ) external view returns (DepositStatus) {
        DepositInfo memory d = userDeposits[user][depositIndex];

        if (d.principalWithdrawn)
            return DepositStatus.Withdrawn;

        if (adminCycleCount < d.assignedCycleId)
            return DepositStatus.WaitingForCycle;

        if (!adminCycles[d.assignedCycleId].settled)
            return DepositStatus.CycleInProgress;

        if (!adminCycles[currentCycleId].settled)
            return DepositStatus.LockedInNewCycle;

        return DepositStatus.ReadyToWithdraw;
    }

    function isDepositUnlocked(
        address user,
        uint256 depositIndex
    ) external view returns (bool) {
        DepositInfo memory d = userDeposits[user][depositIndex];
        if (d.principalWithdrawn) return false;
        return adminCycles[d.assignedCycleId].settled &&
               adminCycles[currentCycleId].settled;
    }

    function pendingProfit(
        address user,
        uint256 depositIndex
    ) external view returns (uint256) {
        DepositInfo memory d = userDeposits[user][depositIndex];
        if (d.amount == 0 || d.principalWithdrawn) return 0;

        uint256 nextCycle = d.lastClaimedCycleId + 1;
        if (nextCycle < d.assignedCycleId) return 0;

        AdminCycle memory c = adminCycles[nextCycle];
        if (!c.settled || c.roiBps == 0) return 0;

        return (d.amount * c.roiBps) / BASIS_POINTS;
    }

    function totalPendingProfit(
        address user,
        uint256 depositIndex
    ) external view returns (uint256 total) {
        DepositInfo memory d = userDeposits[user][depositIndex];
        if (d.amount == 0 || d.principalWithdrawn) return 0;

        for (uint256 cid = d.lastClaimedCycleId + 1; cid <= currentCycleId; cid++) {
            AdminCycle memory c = adminCycles[cid];
            if (!c.settled) break;
            if (cid < d.assignedCycleId) continue;
            if (c.roiBps == 0) continue;
            total += (d.amount * c.roiBps) / BASIS_POINTS;
        }
    }

    function getEligibleTVL() external view returns (uint256) {
        return totalDeposited - pendingDeposits;
    }

    function getCycle(
        uint256 cycleId
    ) external view returns (AdminCycle memory) {
        return adminCycles[cycleId];
    }

    function getCurrentCycle() external view returns (AdminCycle memory) {
        return adminCycles[currentCycleId];
    }

    function getUserDeposits(
        address user
    ) external view returns (DepositInfo[] memory) {
        return userDeposits[user];
    }

    function getDepositHistory(
        address user
    ) external view returns (TxRecord[] memory) {
        return depositHistory[user];
    }

    function getProfitWithdrawHistory(
        address user
    ) external view returns (TxRecord[] memory) {
        return profitWithdrawHistory[user];
    }

    function getPrincipalWithdrawHistory(
        address user
    ) external view returns (TxRecord[] memory) {
        return principalWithdrawHistory[user];
    }

    function getOwnerDepositHistory()
        external view returns (TxRecord[] memory) {
        return ownerDepositHistory;
    }

    function getOwnerWithdrawHistory()
        external view returns (TxRecord[] memory) {
        return ownerWithdrawHistory;
    }
}
