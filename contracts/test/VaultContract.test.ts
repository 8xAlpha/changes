import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";

const { viem, networkHelpers } = await hre.network.connect();

/** Same hardcoded address pattern as presale tests — MockUSDT code is set at this address. */
const USDT_ADDRESS = "0xC82d39eAB653a7eC66d1B017d7CB1ea4aC9E6e9e";
const USDT_DECIMALS = 10n ** 6n;
const BASIS_POINTS = 10_000n;

function expectedUserProfit(depositAmount: bigint, roiBps: bigint) {
  return (depositAmount * roiBps) / BASIS_POINTS;
}

/** viem `ContractFunctionExecutionError` often puts the revert string in `details`, not `message`. */
function viemRevertIncludes(err: unknown, needle: string): boolean {
  const parts: string[] = [];
  let e: unknown = err;
  const seen = new Set<unknown>();
  while (e !== undefined && e !== null && !seen.has(e)) {
    seen.add(e);
    if (e instanceof Error) {
      parts.push(e.message);
      const d = (e as { details?: string }).details;
      if (typeof d === "string") parts.push(d);
    } else {
      parts.push(String(e));
      break;
    }
    e = e instanceof Error ? e.cause : undefined;
  }
  return parts.join("\n").includes(needle);
}

/** `adminCycles` public getter returns a tuple from viem (not always named). */
function parseAdminCycle(raw: unknown) {
  const a = raw as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean];
  if (Array.isArray(raw) && raw.length >= 9) {
    return {
      cycleId: a[0],
      withdrawAmount: a[1],
      withdrawTime: a[2],
      tvlAtWithdraw: a[3],
      depositAmount: a[4],
      depositTime: a[5],
      profit: a[6],
      roiBps: a[7],
      settled: Boolean(a[8]),
    };
  }
  const o = raw as {
    cycleId: bigint;
    withdrawAmount: bigint;
    withdrawTime: bigint;
    tvlAtWithdraw: bigint;
    depositAmount: bigint;
    depositTime: bigint;
    profit: bigint;
    roiBps: bigint;
    settled: boolean;
  };
  return {
    cycleId: BigInt(o.cycleId),
    withdrawAmount: BigInt(o.withdrawAmount),
    withdrawTime: BigInt(o.withdrawTime),
    tvlAtWithdraw: BigInt(o.tvlAtWithdraw),
    depositAmount: BigInt(o.depositAmount),
    depositTime: BigInt(o.depositTime),
    profit: BigInt(o.profit),
    roiBps: BigInt(o.roiBps),
    settled: Boolean(o.settled),
  };
}

async function deployFixture() {
  const wallets = await viem.getWalletClients();
  assert.ok(wallets && wallets.length >= 8, "need at least 8 wallets");

  const [owner, _mod, user, other, liquidity, treasury, team, marketing] = wallets;

  const mockUsdtArtifact = await hre.artifacts.readArtifact("MockUSDT");
  await networkHelpers.setCode(USDT_ADDRESS, mockUsdtArtifact.deployedBytecode);
  const mockUsdt = await viem.getContractAt("MockUSDT", USDT_ADDRESS);

  const vault = await viem.deployContract("VaultContract", [USDT_ADDRESS] as const);
  const presale = await viem.deployContract("ProjectTokenPresale", [
    "Singularity",
    "SGL",
    liquidity.account.address,
    treasury.account.address,
    team.account.address,
    marketing.account.address,
    USDT_ADDRESS,
  ] as const);

  await presale.write.setVaultContract([vault.address], { account: owner.account });
  await vault.write.setPresaleContract([presale.address], { account: owner.account });

  return { owner, user, other, vault, presale, mockUsdt };
}

/**
 * User must already have USDT in the vault (e.g. via `deposit`).
 * Owner pulls `withdrawAmt` then returns `depositBack` (must be > withdrawAmt for roiBps > 0).
 */
async function settleCycleForDeposits(
  vault: Awaited<ReturnType<typeof deployFixture>>["vault"],
  mockUsdt: Awaited<ReturnType<typeof deployFixture>>["mockUsdt"],
  owner: Awaited<ReturnType<typeof deployFixture>>["owner"],
  withdrawAmt: bigint,
  depositBack: bigint
) {
  await mockUsdt.write.mint([owner.account.address, depositBack]);
  await mockUsdt.write.approve([vault.address, depositBack], { account: owner.account });
  await vault.write.ownerWithdraw([withdrawAmt], { account: owner.account });
  await vault.write.ownerDeposit([depositBack], { account: owner.account });
}

describe("VaultContract", function () {
  describe("deposit (positive)", function () {
    it("records deposit, assignedCycleId = currentCycleId + 1, updates totals/history", async function () {
      const { vault, mockUsdt, user } = await networkHelpers.loadFixture(deployFixture);
      const amount = 750n * USDT_DECIMALS;
      await mockUsdt.write.mint([user.account.address, amount]);
      await mockUsdt.write.approve([vault.address, amount], { account: user.account });

      assert.equal(await vault.read.currentCycleId(), 0n);
      await vault.write.deposit([amount], { account: user.account });

      const deposits = await vault.read.getUserDeposits([user.account.address]);
      assert.equal(deposits.length, 1);
      assert.equal(deposits[0].amount, amount);
      assert.equal(deposits[0].assignedCycleId, 1n);
      assert.equal(deposits[0].principalWithdrawn, false);
      assert.equal(deposits[0].totalClaimed, 0n);
      assert.equal(deposits[0].lastClaimedCycleId, 0n);
      assert.equal(await vault.read.totalDeposited(), amount);

      const history = await vault.read.getDepositHistory([user.account.address]);
      assert.equal(history.length, 1);
      assert.equal(history[0].amount, amount);
    });

    it("issues presale tokens when presale active (vault deposit path)", async function () {
      const { vault, presale, mockUsdt, user } = await networkHelpers.loadFixture(deployFixture);
      const amount = 100n * USDT_DECIMALS;
      await mockUsdt.write.mint([user.account.address, amount]);
      await mockUsdt.write.approve([vault.address, amount], { account: user.account });

      const before = await presale.read.balanceOf([user.account.address]);
      await vault.write.deposit([amount], { account: user.account });
      const after = await presale.read.balanceOf([user.account.address]);
      const expected = (amount * 10n ** 18n) / 100_000n;
      assert.equal(after - before, expected);
    });
  });

  describe("deposit (negative)", function () {
    it("reverts below minDeposit", async function () {
      const { vault, mockUsdt, user, owner } = await networkHelpers.loadFixture(deployFixture);
      const min = 100n * USDT_DECIMALS;
      await vault.write.setMinDeposit([min], { account: owner.account });
      const amount = 99n * USDT_DECIMALS;
      await mockUsdt.write.mint([user.account.address, amount]);
      await mockUsdt.write.approve([vault.address, amount], { account: user.account });
      await assert.rejects(
        () => vault.write.deposit([amount], { account: user.account }),
        /Below minimum deposit amount/
      );
    });

    it("reverts when paused", async function () {
      const { vault, mockUsdt, user, owner } = await networkHelpers.loadFixture(deployFixture);
      const amount = 50n * USDT_DECIMALS;
      await mockUsdt.write.mint([user.account.address, amount]);
      await mockUsdt.write.approve([vault.address, amount], { account: user.account });
      await vault.write.pause({ account: owner.account });
      await assert.rejects(
        () => vault.write.deposit([amount], { account: user.account }),
        /Vault is paused/
      );
    });

    it("reverts at 100 deposits cap", async function () {
      const { vault, mockUsdt, user, owner } = await networkHelpers.loadFixture(deployFixture);
      await vault.write.setMinDeposit([0n], { account: owner.account });
      const one = 1n;
      await mockUsdt.write.mint([user.account.address, 100n * one]);
      await mockUsdt.write.approve([vault.address, 100n * one], { account: user.account });
      for (let i = 0; i < 100; i++) {
        await vault.write.deposit([one], { account: user.account });
      }
      await assert.rejects(
        () => vault.write.deposit([one], { account: user.account }),
        /Max 100 deposits per wallet/
      );
    });
  });

  describe("recordDepositFrom (presale path)", function () {
    it("buy() on presale forwards USDT and records vault deposit for buyer", async function () {
      const { vault, presale, mockUsdt, user } = await networkHelpers.loadFixture(deployFixture);
      const amount = 200n * USDT_DECIMALS;
      await mockUsdt.write.mint([user.account.address, amount]);
      await mockUsdt.write.approve([presale.address, amount], { account: user.account });
      await presale.write.buy([amount], { account: user.account });

      const deposits = await vault.read.getUserDeposits([user.account.address]);
      assert.equal(deposits.length, 1);
      assert.equal(deposits[0].amount, amount);
      assert.equal(await mockUsdt.read.balanceOf([vault.address]), amount);
    });

    it("reverts if caller is not presale", async function () {
      const { vault, mockUsdt, user, owner } = await networkHelpers.loadFixture(deployFixture);
      await mockUsdt.write.mint([owner.account.address, 10n * USDT_DECIMALS]);
      await mockUsdt.write.transfer([vault.address, 10n * USDT_DECIMALS], {
        account: owner.account,
      });
      await assert.rejects(
        () =>
          vault.write.recordDepositFrom([user.account.address, 10n * USDT_DECIMALS], {
            account: user.account,
          }),
        /Caller is not the presale/
      );
    });
  });

  describe("admin cycle", function () {
    it("ownerWithdraw opens cycle; ownerDeposit settles with correct roiBps", async function () {
      const { vault, mockUsdt, user, owner } = await networkHelpers.loadFixture(deployFixture);
      const depositAmt = 1_000n * USDT_DECIMALS;
      await mockUsdt.write.mint([user.account.address, depositAmt]);
      await mockUsdt.write.approve([vault.address, depositAmt], { account: user.account });
      await vault.write.deposit([depositAmt], { account: user.account });

      const withdrawAmt = 800n * USDT_DECIMALS;
      const depositBack = 880n * USDT_DECIMALS;
      await settleCycleForDeposits(vault, mockUsdt, owner, withdrawAmt, depositBack);

      const c = parseAdminCycle(await vault.read.adminCycles([1n]));
      assert.equal(c.settled, true);
      assert.equal(c.withdrawAmount, withdrawAmt);
      assert.equal(c.depositAmount, depositBack);
      assert.equal(c.profit, 80n * USDT_DECIMALS);
      assert.equal(c.roiBps, (80n * USDT_DECIMALS * BASIS_POINTS) / (1_000n * USDT_DECIMALS));
    });

    it("reverts ownerWithdraw if previous cycle not settled", async function () {
      const { vault, mockUsdt, user, owner } = await networkHelpers.loadFixture(deployFixture);
      const d = 500n * USDT_DECIMALS;
      await mockUsdt.write.mint([user.account.address, d]);
      await mockUsdt.write.approve([vault.address, d], { account: user.account });
      await vault.write.deposit([d], { account: user.account });
      await vault.write.ownerWithdraw([100n * USDT_DECIMALS], { account: owner.account });
      await assert.rejects(
        () => vault.write.ownerWithdraw([100n * USDT_DECIMALS], { account: owner.account }),
        /Previous cycle not settled yet/
      );
    });

    it("reverts ownerDeposit without prior ownerWithdraw", async function () {
      const { vault, mockUsdt, owner } = await networkHelpers.loadFixture(deployFixture);
      const amt = 100n * USDT_DECIMALS;
      await mockUsdt.write.mint([owner.account.address, amt]);
      await mockUsdt.write.approve([vault.address, amt], { account: owner.account });
      await assert.rejects(
        () => vault.write.ownerDeposit([amt], { account: owner.account }),
        (err: unknown) => viemRevertIncludes(err, "No open cycle, call ownerWithdraw first")
      );
    });

    it("non-owner cannot ownerWithdraw / ownerDeposit", async function () {
      const { vault, mockUsdt, user, owner } = await networkHelpers.loadFixture(deployFixture);
      const d = 300n * USDT_DECIMALS;
      await mockUsdt.write.mint([user.account.address, d]);
      await mockUsdt.write.approve([vault.address, d], { account: user.account });
      await vault.write.deposit([d], { account: user.account });

      await assert.rejects(
        () => vault.write.ownerWithdraw([100n * USDT_DECIMALS], { account: user.account }),
        /OwnableUnauthorizedAccount|not the owner/i
      );

      await mockUsdt.write.mint([user.account.address, 200n * USDT_DECIMALS]);
      await mockUsdt.write.approve([vault.address, 200n * USDT_DECIMALS], {
        account: user.account,
      });
      await assert.rejects(
        () => vault.write.ownerDeposit([200n * USDT_DECIMALS], { account: user.account }),
        /OwnableUnauthorizedAccount|not the owner/i
      );
    });
  });

  describe("withdrawProfit", function () {
    it("pays profit once after cycle settles", async function () {
      const { vault, mockUsdt, user, owner } = await networkHelpers.loadFixture(deployFixture);
      const principal = 1_000n * USDT_DECIMALS;
      await mockUsdt.write.mint([user.account.address, principal]);
      await mockUsdt.write.approve([vault.address, principal], { account: user.account });
      await vault.write.deposit([principal], { account: user.account });

      await settleCycleForDeposits(
        vault,
        mockUsdt,
        owner,
        800n * USDT_DECIMALS,
        880n * USDT_DECIMALS
      );

      const c = parseAdminCycle(await vault.read.adminCycles([1n]));
      const profit = expectedUserProfit(principal, c.roiBps);
      assert.ok(profit > 0n);

      const before = await mockUsdt.read.balanceOf([user.account.address]);
      await vault.write.withdrawProfit([0n], { account: user.account });
      const after = await mockUsdt.read.balanceOf([user.account.address]);
      assert.equal(after - before, profit);

      // Per-cycle claims: after cycle 1, next claim targets cycle 2 (never opened) → not "already claimed"
      await assert.rejects(
        () => vault.write.withdrawProfit([0n], { account: user.account }),
        (err: unknown) =>
          viemRevertIncludes(err, "Cycle not settled yet, wait for admin to deposit profit")
      );
    });

    it("reverts if cycle not settled", async function () {
      const { vault, mockUsdt, user } = await networkHelpers.loadFixture(deployFixture);
      const principal = 100n * USDT_DECIMALS;
      await mockUsdt.write.mint([user.account.address, principal]);
      await mockUsdt.write.approve([vault.address, principal], { account: user.account });
      await vault.write.deposit([principal], { account: user.account });

      await assert.rejects(
        () => vault.write.withdrawProfit([0n], { account: user.account }),
        /Cycle not settled yet/
      );
    });

    it("reverts when roiBps is zero (loss cycle)", async function () {
      const { vault, mockUsdt, user, owner } = await networkHelpers.loadFixture(deployFixture);
      const principal = 1_000n * USDT_DECIMALS;
      await mockUsdt.write.mint([user.account.address, principal]);
      await mockUsdt.write.approve([vault.address, principal], { account: user.account });
      await vault.write.deposit([principal], { account: user.account });

      await mockUsdt.write.mint([owner.account.address, 700n * USDT_DECIMALS]);
      await mockUsdt.write.approve([vault.address, 700n * USDT_DECIMALS], {
        account: owner.account,
      });
      await vault.write.ownerWithdraw([800n * USDT_DECIMALS], { account: owner.account });
      await vault.write.ownerDeposit([700n * USDT_DECIMALS], { account: owner.account });

      await assert.rejects(
        () => vault.write.withdrawProfit([0n], { account: user.account }),
        /No profit generated in this cycle/
      );
    });

    it("reverts when paused", async function () {
      const { vault, mockUsdt, user, owner } = await networkHelpers.loadFixture(deployFixture);
      const principal = 500n * USDT_DECIMALS;
      await mockUsdt.write.mint([user.account.address, principal]);
      await mockUsdt.write.approve([vault.address, principal], { account: user.account });
      await vault.write.deposit([principal], { account: user.account });
      await settleCycleForDeposits(
        vault,
        mockUsdt,
        owner,
        400n * USDT_DECIMALS,
        450n * USDT_DECIMALS
      );
      await vault.write.pause({ account: owner.account });
      await assert.rejects(
        () => vault.write.withdrawProfit([0n], { account: user.account }),
        /Vault is paused/
      );
    });
  });

  describe("withdrawPrincipal", function () {
    it("pays principal + profit when profit not claimed separately", async function () {
      const { vault, mockUsdt, user, owner } = await networkHelpers.loadFixture(deployFixture);
      const principal = 1_000n * USDT_DECIMALS;
      await mockUsdt.write.mint([user.account.address, principal]);
      await mockUsdt.write.approve([vault.address, principal], { account: user.account });
      await vault.write.deposit([principal], { account: user.account });

      await settleCycleForDeposits(
        vault,
        mockUsdt,
        owner,
        800n * USDT_DECIMALS,
        880n * USDT_DECIMALS
      );

      const c = parseAdminCycle(await vault.read.adminCycles([1n]));
      const profit = expectedUserProfit(principal, c.roiBps);

      const before = await mockUsdt.read.balanceOf([user.account.address]);
      await vault.write.withdrawPrincipal([0n], { account: user.account });
      const after = await mockUsdt.read.balanceOf([user.account.address]);
      assert.equal(after - before, principal + profit);
      assert.equal(await vault.read.totalDeposited(), 0n);
    });

    it("after withdrawProfit, withdrawPrincipal pays only principal", async function () {
      const { vault, mockUsdt, user, owner } = await networkHelpers.loadFixture(deployFixture);
      const principal = 1_000n * USDT_DECIMALS;
      await mockUsdt.write.mint([user.account.address, principal]);
      await mockUsdt.write.approve([vault.address, principal], { account: user.account });
      await vault.write.deposit([principal], { account: user.account });
      await settleCycleForDeposits(
        vault,
        mockUsdt,
        owner,
        800n * USDT_DECIMALS,
        880n * USDT_DECIMALS
      );

      await vault.write.withdrawProfit([0n], { account: user.account });
      const mid = await mockUsdt.read.balanceOf([user.account.address]);
      await vault.write.withdrawPrincipal([0n], { account: user.account });
      const end = await mockUsdt.read.balanceOf([user.account.address]);
      assert.equal(end - mid, principal);
    });

    it("reverts when principalWithdrawEnabled is false", async function () {
      const { vault, mockUsdt, user, owner } = await networkHelpers.loadFixture(deployFixture);
      const principal = 200n * USDT_DECIMALS;
      await mockUsdt.write.mint([user.account.address, principal]);
      await mockUsdt.write.approve([vault.address, principal], { account: user.account });
      await vault.write.deposit([principal], { account: user.account });
      await settleCycleForDeposits(
        vault,
        mockUsdt,
        owner,
        150n * USDT_DECIMALS,
        170n * USDT_DECIMALS
      );
      await vault.write.togglePrincipalWithdraw({ account: owner.account });
      await assert.rejects(
        () => vault.write.withdrawPrincipal([0n], { account: user.account }),
        /Principal withdrawal is currently disabled/
      );
    });
  });

  describe("views", function () {
    it("pendingProfit matches withdrawable amount", async function () {
      const { vault, mockUsdt, user, owner } = await networkHelpers.loadFixture(deployFixture);
      const principal = 600n * USDT_DECIMALS;
      await mockUsdt.write.mint([user.account.address, principal]);
      await mockUsdt.write.approve([vault.address, principal], { account: user.account });
      await vault.write.deposit([principal], { account: user.account });
      await settleCycleForDeposits(
        vault,
        mockUsdt,
        owner,
        400n * USDT_DECIMALS,
        440n * USDT_DECIMALS
      );
      const c = parseAdminCycle(await vault.read.adminCycles([1n]));
      const expected = expectedUserProfit(principal, c.roiBps);
      const pending = await vault.read.pendingProfit([user.account.address, 0n]);
      assert.equal(pending, expected);
      await vault.write.withdrawProfit([0n], { account: user.account });
      assert.equal(await vault.read.pendingProfit([user.account.address, 0n]), 0n);
    });
  });

  describe("setPresaleContract (negative)", function () {
    it("reverts zero address and EOA (no code)", async function () {
      const { vault, owner, other } = await networkHelpers.loadFixture(deployFixture);
      await assert.rejects(
        () =>
          vault.write.setPresaleContract([`0x${"0".repeat(40)}` as `0x${string}`], {
            account: owner.account,
          }),
        /Zero address/
      );
      await assert.rejects(
        () => vault.write.setPresaleContract([other.account.address], { account: owner.account }),
        /Not a contract/
      );
    });
  });

  describe("pause", function () {
    it("blocks user flows; unpause restores", async function () {
      const { vault, mockUsdt, owner, user } = await networkHelpers.loadFixture(deployFixture);
      const principal = 100n * USDT_DECIMALS;
      await mockUsdt.write.mint([user.account.address, principal * 2n]);
      await mockUsdt.write.approve([vault.address, principal * 2n], { account: user.account });
      await vault.write.deposit([principal], { account: user.account });
      await vault.write.pause({ account: owner.account });
      await assert.rejects(
        () => vault.write.deposit([principal], { account: user.account }),
        /Vault is paused/
      );
      await vault.write.unpause({ account: owner.account });
      await vault.write.deposit([principal], { account: user.account });
    });

    it("ownerWithdraw / ownerDeposit are not blocked by pause", async function () {
      const { vault, mockUsdt, user, owner } = await networkHelpers.loadFixture(deployFixture);
      const d = 400n * USDT_DECIMALS;
      await mockUsdt.write.mint([user.account.address, d]);
      await mockUsdt.write.approve([vault.address, d], { account: user.account });
      await vault.write.deposit([d], { account: user.account });
      await vault.write.pause({ account: owner.account });
      await mockUsdt.write.mint([owner.account.address, 500n * USDT_DECIMALS]);
      await mockUsdt.write.approve([vault.address, 500n * USDT_DECIMALS], {
        account: owner.account,
      });
      await vault.write.ownerWithdraw([300n * USDT_DECIMALS], { account: owner.account });
      await vault.write.ownerDeposit([350n * USDT_DECIMALS], { account: owner.account });
    });
  });
});
