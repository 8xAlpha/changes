import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";
import { parseUnits, getAddress } from "viem";

const { viem, networkHelpers } = await hre.network.connect();

const U = (n: number | string) => parseUnits(String(n), 6);

/** getCurrentCycle as the admin panel decodes it today (v1 AdminCycle). */
const ADMIN_PANEL_CYCLE_ABI = [
  {
    type: "function",
    name: "getCurrentCycle",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "cycleId", type: "uint256" },
          { name: "withdrawAmount", type: "uint256" },
          { name: "withdrawTime", type: "uint256" },
          { name: "tvlAtWithdraw", type: "uint256" },
          { name: "depositAmount", type: "uint256" },
          { name: "depositTime", type: "uint256" },
          { name: "profit", type: "uint256" },
          { name: "roiBps", type: "uint256" },
          { name: "settled", type: "bool" },
        ],
      },
    ],
  },
] as const;

/** getUserDeposits as the website decodes it today (v1 DepositInfo). */
const WEBSITE_DEPOSITS_ABI = [
  {
    type: "function",
    name: "getUserDeposits",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "amount", type: "uint256" },
          { name: "startTime", type: "uint256" },
          { name: "assignedCycleId", type: "uint256" },
          { name: "totalClaimed", type: "uint256" },
          { name: "principalWithdrawn", type: "bool" },
          { name: "lastClaimedCycleId", type: "uint256" },
        ],
      },
    ],
  },
] as const;
const STATUS = { Waiting: 0, InCycle: 1, Ready: 2, Withdrawn: 3 } as const;

/** viem often puts the revert string in `details` or a nested cause, not `message`. */
function revertIncludes(err: unknown, needle: string): boolean {
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

async function expectRevert(p: Promise<unknown>, needle: string) {
  await assert.rejects(p, (err) => {
    assert.ok(revertIncludes(err, needle), `expected revert "${needle}", got: ${String(err).slice(0, 300)}`);
    return true;
  });
}

function assertClose(actual: bigint, expected: bigint, tolerance: bigint, label = "") {
  const diff = actual > expected ? actual - expected : expected - actual;
  assert.ok(diff <= tolerance, `${label} expected ${expected} ±${tolerance}, got ${actual}`);
}

async function baseFixture() {
  const wallets = await viem.getWalletClients();
  const [owner, alice, bob, carol, dave, liq, treasury, team, marketing] = wallets;
  const usdt = await viem.deployContract("MockUSDT");
  const vault = await viem.deployContract("VaultContractV2", [usdt.address, owner.account.address]);
  const token = await viem.deployContract("ProjectTokenPresale", [
    "singularity token",
    "SLF",
    liq.account.address,
    treasury.account.address,
    team.account.address,
    marketing.account.address,
    usdt.address,
  ]);
  await token.write.setVaultContract([vault.address]);
  await vault.write.setPresaleContract([token.address]);

  const users = [alice, bob, carol, dave];
  for (const u of users) {
    await usdt.write.mint([u.account.address, U(1_000_000)]);
    await usdt.write.approve([vault.address, U(1_000_000_000)], { account: u.account });
    await usdt.write.approve([token.address, U(1_000_000_000)], { account: u.account });
  }
  await usdt.write.mint([owner.account.address, U(10_000_000)]);
  await usdt.write.approve([vault.address, U(1_000_000_000_000)]);

  const publicClient = await viem.getPublicClient();
  const balance = (addr: `0x${string}`) => usdt.read.balanceOf([addr]);

  return { owner, alice, bob, carol, dave, usdt, vault, token, publicClient, balance, wallets };
}

async function accountedBalance(vault: any) {
  const active = await vault.read.activePrincipal();
  const deployed = await vault.read.deployedPrincipal();
  const pending = await vault.read.pendingPrincipal();
  const reserve = await vault.read.profitReserve();
  return active - deployed + pending + reserve;
}

async function assertSolvent(vault: any, usdt: any) {
  const bal = await usdt.read.balanceOf([vault.address]);
  const owed = await accountedBalance(vault);
  assert.ok(bal >= owed, `vault insolvent: balance ${bal} < owed ${owed}`);
}

describe("VaultContractV2", () => {
  describe("ownership", () => {
    it("sets the owner from the constructor, not the deployer", async () => {
      const { usdt, alice } = await networkHelpers.loadFixture(baseFixture);
      const v = await viem.deployContract("VaultContractV2", [usdt.address, alice.account.address]);
      assert.equal(getAddress(await v.read.owner()), getAddress(alice.account.address));
    });

    it("needs the new owner to accept a transfer (two-step)", async () => {
      const { vault, owner, bob } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.transferOwnership([bob.account.address]);
      assert.equal(getAddress(await vault.read.owner()), getAddress(owner.account.address));
      await vault.write.acceptOwnership({ account: bob.account });
      assert.equal(getAddress(await vault.read.owner()), getAddress(bob.account.address));
    });

    it("cannot renounce ownership", async () => {
      const { vault } = await networkHelpers.loadFixture(baseFixture);
      await expectRevert(vault.write.renounceOwnership(), "Renounce disabled");
    });

    it("rejects owner functions from anyone else", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(baseFixture);
      for (const call of [
        () => vault.write.ownerWithdraw([1n], { account: alice.account }),
        () => vault.write.distributeProfit([1n], { account: alice.account }),
        () => vault.write.ownerReturnPrincipal([1n], { account: alice.account }),
        () => vault.write.ownerCloseCycleWithLoss([0n], { account: alice.account }),
        () => vault.write.sweepSurplus({ account: alice.account }),
        () => vault.write.togglePrincipalWithdraw({ account: alice.account }),
      ]) {
        await expectRevert(call(), "OwnableUnauthorizedAccount");
      }
    });
  });

  describe("website compatibility", () => {
    it("returns deposits in v1's 6-field layout and statuses 0-3", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(1000)], { account: alice.account });

      const [d] = await vault.read.getUserDeposits([alice.account.address]);
      assert.equal(d.amount, U(1000));
      assert.equal(d.activationRound, 1n);

      const publicClient = await viem.getPublicClient();
      const [asWebsite] = await publicClient.readContract({
        address: vault.address,
        abi: WEBSITE_DEPOSITS_ABI,
        functionName: "getUserDeposits",
        args: [alice.account.address],
      });
      assert.equal(asWebsite.amount, U(1000));
      assert.equal(asWebsite.principalWithdrawn, false);
      assert.equal(d.totalClaimed, 0n);
      assert.equal(d.principalWithdrawn, false);
      assert.equal(await vault.read.getDepositStatus([alice.account.address, 0n]), STATUS.Waiting);

      await vault.write.ownerWithdraw([U(1000)]);
      assert.equal(await vault.read.getDepositStatus([alice.account.address, 0n]), STATUS.InCycle);

      await vault.write.ownerReturnPrincipal([U(1000)]);
      assert.equal(await vault.read.getDepositStatus([alice.account.address, 0n]), STATUS.Ready);

      await vault.write.withdrawPrincipal([0n], { account: alice.account });
      assert.equal(await vault.read.getDepositStatus([alice.account.address, 0n]), STATUS.Withdrawn);
      const [after] = await vault.read.getUserDeposits([alice.account.address]);
      assert.equal(after.amount, 0n, "amount is zeroed after withdrawal, like v1");
      assert.equal(after.principalPaid, U(1000));
    });
  });

  describe("admin panel compatibility", () => {
    it("serves the current cycle in the layout the admin panel already decodes", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(baseFixture);
      const publicClient = await viem.getPublicClient();
      const asAdmin = () =>
        publicClient.readContract({ address: vault.address, abi: ADMIN_PANEL_CYCLE_ABI, functionName: "getCurrentCycle" });

      await vault.write.deposit([U(1000)], { account: alice.account });
      await vault.write.ownerWithdraw([U(1000)]);
      await vault.write.distributeProfit([U(20)]);
      await vault.write.distributeProfit([U(10)]);

      let c = await asAdmin();
      assert.equal(c.cycleId, 1n);
      assert.equal(c.withdrawAmount, U(1000));
      assert.ok(c.withdrawTime > 0n);
      assert.equal(c.tvlAtWithdraw, U(1000));
      assert.equal(c.profit, U(30));
      assert.equal(c.roiBps, 300n, "3% so far this cycle");
      assert.equal(c.settled, false);

      await vault.write.ownerReturnPrincipal([U(1000)]);
      c = await asAdmin();
      assert.equal(c.depositAmount, U(1000));
      assert.ok(c.depositTime > 0n);
      assert.equal(c.settled, true);

      const [first, second] = await vault.read.getROIHistory();
      assert.equal(first.roi, 200n);
      assert.equal(second.roi, 100n);
    });
  });

  describe("deposits", () => {
    it("waits as pending, earns nothing before joining, and blocks profit distribution with no active deposits", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(1000)], { account: alice.account });
      assert.equal(await vault.read.pendingPrincipal(), U(1000));
      assert.equal(await vault.read.activePrincipal(), 0n);
      await expectRevert(vault.write.distributeProfit([U(10)]), "No active deposits");
    });

    it("locks waiting deposits while a cycle is open, like every other deposit", async () => {
      const { vault, alice, bob, balance } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(1000)], { account: alice.account });
      await vault.write.ownerWithdraw([U(1000)]);
      await vault.write.deposit([U(500)], { account: bob.account });

      assert.equal(await vault.read.getDepositStatus([bob.account.address, 0n]), STATUS.Waiting);
      assert.equal(await vault.read.isDepositUnlocked([bob.account.address, 0n]), false);
      await expectRevert(
        vault.write.withdrawPrincipal([0n], { account: bob.account }),
        "Principal is deployed in an open cycle",
      );

      // The cycle closes, but Bob never took part in it: still locked.
      await vault.write.ownerReturnPrincipal([U(1000)]);
      assert.equal(await vault.read.isDepositUnlocked([bob.account.address, 0n]), false);
      assert.equal(await vault.read.getDepositStatus([bob.account.address, 0n]), STATUS.Waiting);
      await expectRevert(
        vault.write.withdrawPrincipal([0n], { account: bob.account }),
        "Deposit must complete a cycle",
      );

      // He joins at the next withdraw; once that cycle closes he can leave.
      await vault.write.ownerWithdraw([await vault.read.ownerWithdrawable()]);
      await vault.write.ownerReturnPrincipal([await vault.read.deployedPrincipal()]);
      assert.equal(await vault.read.isDepositUnlocked([bob.account.address, 0n]), true);
      const before = await balance(bob.account.address);
      await vault.write.withdrawPrincipal([0n], { account: bob.account });
      assert.equal((await balance(bob.account.address)) - before, U(500));
    });

    it("doesn't refund a deposit in a withdrawal window before it has been through a cycle", async () => {
      const { vault, bob } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(500)], { account: bob.account });
      assert.equal(await vault.read.isCycleOpen(), false);
      await expectRevert(
        vault.write.withdrawPrincipal([0n], { account: bob.account }),
        "Deposit must complete a cycle",
      );
    });

    it("enforces the minimum deposit and the 100-deposit limit", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.setMinDeposit([U(10)]);
      await expectRevert(vault.write.deposit([U(5)], { account: alice.account }), "Below minimum deposit amount");
      await vault.write.setMinDeposit([0n]);
      for (let i = 0; i < 100; i++) await vault.write.deposit([1n], { account: alice.account });
      await expectRevert(vault.write.deposit([1n], { account: alice.account }), "Max 100 deposits per wallet");
    });
  });

  describe("owner withdraw", () => {
    it("activates pending deposits, opens a cycle and sends the funds to the owner", async () => {
      const { vault, alice, owner, balance } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(1000)], { account: alice.account });

      const before = await balance(owner.account.address);
      await vault.write.ownerWithdraw([U(800)]);
      assert.equal((await balance(owner.account.address)) - before, U(800));

      assert.equal(await vault.read.isCycleOpen(), true);
      assert.equal(await vault.read.deployedPrincipal(), U(800));
      assert.equal(await vault.read.activePrincipal(), U(1000));
      const c = await vault.read.getCurrentCycle();
      assert.equal(c.cycleId, 1n);
      assert.equal(c.tvlAtWithdraw, U(1000));
      assert.equal(c.withdrawAmount, U(800));
      assert.equal(c.settled, false);

      await vault.write.ownerWithdraw([U(200)]);
      assert.equal(await vault.read.cycleCount(), 1n, "a second withdraw in the same cycle doesn't open another");
      await expectRevert(vault.write.ownerWithdraw([1n]), "Exceeds undeployed principal");
    });

    it("can never take users' unclaimed profit", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(1000)], { account: alice.account });
      await vault.write.ownerWithdraw([U(1000)]);
      await vault.write.distributeProfit([U(30)]);

      assert.equal(await vault.read.ownerWithdrawable(), 0n);
      await expectRevert(vault.write.ownerWithdraw([1n]), "Exceeds undeployed principal");
      await vault.write.ownerReturnPrincipal([U(1000)]);
      await expectRevert(vault.write.ownerWithdraw([U(1000) + 1n]), "Exceeds undeployed principal");
    });

    it("reports ownerWithdrawable including pending deposits it would activate", async () => {
      const { vault, alice, bob } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(1000)], { account: alice.account });
      await vault.write.ownerWithdraw([U(1000)]);
      await vault.write.deposit([U(250)], { account: bob.account });
      assert.equal(await vault.read.ownerWithdrawable(), U(250));
      await vault.write.ownerWithdraw([U(250)]);
      assert.equal(await vault.read.deployedPrincipal(), U(1250));
    });
  });

  describe("profit", () => {
    it("pays profit on its own, pro rata, claimable while the principal is still deployed", async () => {
      const { vault, alice, bob, balance } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(1000)], { account: alice.account });
      await vault.write.deposit([U(3000)], { account: bob.account });
      await vault.write.ownerWithdraw([U(4000)]);

      await vault.write.distributeProfit([U(40)]); // 1%
      assert.equal(await vault.read.pendingProfit([alice.account.address, 0n]), U(10));
      assert.equal(await vault.read.pendingProfit([bob.account.address, 0n]), U(30));

      const [roi] = await vault.read.getROIHistory();
      assert.equal(roi.roi, 100n, "1% = 100 bps");

      const before = await balance(alice.account.address);
      await vault.write.withdrawProfit([0n], { account: alice.account });
      assert.equal((await balance(alice.account.address)) - before, U(10));
      assert.equal(await vault.read.pendingProfit([alice.account.address, 0n]), 0n);
      await expectRevert(vault.write.withdrawProfit([0n], { account: alice.account }), "No profit to withdraw");
    });

    it("never gets stuck: skipped weeks, losses and late claims all still pay out (v1 bug)", async () => {
      const { vault, alice, bob } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(1000)], { account: alice.account });
      await vault.write.deposit([U(1000)], { account: bob.account });

      // Cycle 1 ends in a loss with no profit at all (this froze claims in v1).
      await vault.write.ownerWithdraw([U(2000)]);
      await vault.write.ownerCloseCycleWithLoss([U(1900)]);

      // Cycle 2: several distributions; Alice claims nothing until the end.
      await vault.write.ownerWithdraw([U(1900)]);
      await vault.write.distributeProfit([U(19)]);
      await vault.write.distributeProfit([U(38)]);
      await vault.write.withdrawProfit([0n], { account: bob.account }); // Bob claims midway
      await vault.write.distributeProfit([U(57)]);

      const alicePending = await vault.read.pendingProfit([alice.account.address, 0n]);
      assertClose(alicePending, U(57), 2n, "Alice's accumulated profit");
      await vault.write.withdrawProfit([0n], { account: alice.account });
      assertClose(await vault.read.pendingProfit([bob.account.address, 0n]), U(28.5), 2n, "Bob's remaining profit");
    });

    it("rejects dust distributions that would round to nothing", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(1_000_000)], { account: alice.account });
      await vault.write.activatePendingDeposits();
      await expectRevert(vault.write.distributeProfit([0n]), "Amount must be > 0");
    });

    it("withdrawAllProfit claims every deposit at once", async () => {
      const { vault, alice, balance } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(100)], { account: alice.account });
      await vault.write.deposit([U(300)], { account: alice.account });
      await vault.write.ownerWithdraw([U(400)]);
      await vault.write.distributeProfit([U(20)]);

      assert.equal(await vault.read.claimableProfitOf([alice.account.address]), U(20));
      const before = await balance(alice.account.address);
      await vault.write.withdrawAllProfit({ account: alice.account });
      assert.equal((await balance(alice.account.address)) - before, U(20));
    });

    it("deposits made during a cycle don't share profit sent before they join", async () => {
      const { vault, alice, bob } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(1000)], { account: alice.account });
      await vault.write.ownerWithdraw([U(1000)]);
      await vault.write.distributeProfit([U(10)]);

      await vault.write.deposit([U(500)], { account: bob.account }); // pending
      await vault.write.distributeProfit([U(10)]);
      assert.equal(await vault.read.pendingProfit([bob.account.address, 0n]), 0n);
      assert.equal(await vault.read.pendingProfit([alice.account.address, 0n]), U(20));

      await vault.write.ownerWithdraw([U(500)]); // Bob joins
      await vault.write.distributeProfit([U(15)]);
      assert.equal(await vault.read.pendingProfit([alice.account.address, 0n]), U(30));
      assert.equal(await vault.read.pendingProfit([bob.account.address, 0n]), U(5));
    });

    it("activatePendingDeposits starts earning without moving principal", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(1000)], { account: alice.account });
      await vault.write.activatePendingDeposits();
      assert.equal(await vault.read.isCycleOpen(), false);
      await vault.write.distributeProfit([U(25)]);
      assert.equal(await vault.read.pendingProfit([alice.account.address, 0n]), U(25));
      await vault.write.withdrawProfit([0n], { account: alice.account });
      // Earning, but its first cycle hasn't happened yet: principal stays locked.
      assert.equal(await vault.read.getDepositStatus([alice.account.address, 0n]), STATUS.Waiting);
      await expectRevert(
        vault.write.withdrawPrincipal([0n], { account: alice.account }),
        "Deposit must complete a cycle",
      );
      await vault.write.ownerWithdraw([U(1000)]);
      await vault.write.ownerReturnPrincipal([U(1000)]);
      assert.equal(await vault.read.getDepositStatus([alice.account.address, 0n]), STATUS.Ready);
      await vault.write.withdrawPrincipal([0n], { account: alice.account });
    });
  });

  describe("principal", () => {
    it("is locked while any principal is deployed and unlocks once all of it is returned", async () => {
      const { vault, alice, balance } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(1000)], { account: alice.account });
      await vault.write.ownerWithdraw([U(1000)]);
      await vault.write.distributeProfit([U(30)]);

      await expectRevert(
        vault.write.withdrawPrincipal([0n], { account: alice.account }),
        "Principal is deployed in an open cycle",
      );
      await vault.write.ownerReturnPrincipal([U(600)]);
      assert.equal(await vault.read.isCycleOpen(), true, "partial return keeps the cycle open");
      await expectRevert(
        vault.write.withdrawPrincipal([0n], { account: alice.account }),
        "Principal is deployed in an open cycle",
      );

      await vault.write.ownerReturnPrincipal([U(400)]);
      assert.equal(await vault.read.isCycleOpen(), false);
      const c = await vault.read.getCycle([1n]);
      assert.equal(c.settled, true);
      assert.equal(c.depositAmount, U(1000));
      assert.equal(await vault.read.cycleLoss([1n]), 0n);

      const before = await balance(alice.account.address);
      await vault.write.withdrawPrincipal([0n], { account: alice.account });
      assert.equal((await balance(alice.account.address)) - before, U(1030), "principal + unclaimed profit");
    });

    it("won't accept more than was deployed as principal", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(1000)], { account: alice.account });
      await vault.write.ownerWithdraw([U(1000)]);
      await expectRevert(vault.write.ownerReturnPrincipal([U(1001)]), "More than deployed");
    });

    it("respects the principal-withdraw switch for pending and active deposits", async () => {
      const { vault, alice, bob } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(1000)], { account: alice.account });
      await vault.write.ownerWithdraw([U(1000)]);
      await vault.write.ownerReturnPrincipal([U(1000)]);
      await vault.write.deposit([U(1000)], { account: bob.account });
      await vault.write.togglePrincipalWithdraw();
      await expectRevert(vault.write.withdrawPrincipal([0n], { account: alice.account }), "currently disabled");
      await expectRevert(vault.write.withdrawPrincipal([0n], { account: bob.account }), "currently disabled");
      assert.equal(await vault.read.isDepositUnlocked([alice.account.address, 0n]), false);
      await vault.write.togglePrincipalWithdraw();
      await vault.write.withdrawPrincipal([0n], { account: alice.account });
    });
  });

  describe("buy-and-refund protection (audit C-1)", () => {
    it("a presale buyer can't refund before the deposit has been through a cycle", async () => {
      const { vault, token, bob } = await networkHelpers.loadFixture(baseFixture);
      await token.write.buy([U(50_000)], { account: bob.account });
      await expectRevert(vault.write.withdrawPrincipal([0n], { account: bob.account }), "Deposit must complete a cycle");
    });

    it("a flash-loan buy-and-refund of the whole presale reverts entirely", async () => {
      const { vault, token, usdt, alice, dave } = await networkHelpers.loadFixture(baseFixture);
      // A withdrawal window is open: one cycle has run and closed.
      await vault.write.deposit([U(1000)], { account: alice.account });
      await vault.write.ownerWithdraw([U(1000)]);
      await vault.write.ownerReturnPrincipal([U(1000)]);

      const lender = await viem.deployContract("FlashLenderMock", [usdt.address]);
      await usdt.write.mint([lender.address, U(11_000_000)]);
      const attacker = await viem.deployContract("PresaleFreeRiderMock", [
        usdt.address,
        token.address,
        vault.address,
        lender.address,
        dave.account.address,
      ]);
      const cap = await token.read.remainingCap();
      await expectRevert(attacker.write.attackWithFlashLoan([cap], { account: dave.account }), "Deposit must complete a cycle");
      assert.equal(await token.read.balanceOf([dave.account.address]), 0n);
      assert.equal(await token.read.presaleActive(), true);
    });

    it("recycling the same USDT through deposit() and withdraw reverts", async () => {
      const { vault, token, usdt, dave } = await networkHelpers.loadFixture(baseFixture);
      const lender = await viem.deployContract("FlashLenderMock", [usdt.address]);
      const attacker = await viem.deployContract("PresaleFreeRiderMock", [
        usdt.address,
        token.address,
        vault.address,
        lender.address,
        dave.account.address,
      ]);
      await usdt.write.transfer([attacker.address, U(1000)], { account: dave.account });
      await expectRevert(attacker.write.recycleDeposits([U(1000), 5n], { account: dave.account }), "Deposit must complete a cycle");
    });

    it("the owner activating deposits in a window doesn't unlock them early", async () => {
      const { vault, token, bob } = await networkHelpers.loadFixture(baseFixture);
      await token.write.buy([U(1000)], { account: bob.account });
      await vault.write.activatePendingDeposits();
      assert.equal(await vault.read.isDepositUnlocked([bob.account.address, 0n]), false);
      await expectRevert(vault.write.withdrawPrincipal([0n], { account: bob.account }), "Deposit must complete a cycle");
    });

    it("a deposit that joins mid-cycle (weekly withdraw) can leave once that cycle closes", async () => {
      const { vault, alice, bob, balance } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(1000)], { account: alice.account });
      await vault.write.ownerWithdraw([U(1000)]); // cycle 1 opens
      await vault.write.deposit([U(500)], { account: bob.account });
      await vault.write.distributeProfit([U(10)]); // week 1: only Alice
      await vault.write.ownerWithdraw([U(500)]); // week 2 withdraw: Bob joins cycle 1
      assert.equal(await vault.read.getDepositStatus([bob.account.address, 0n]), STATUS.InCycle);
      await vault.write.distributeProfit([U(15)]); // Alice 10, Bob 5
      await vault.write.ownerReturnPrincipal([U(1500)]); // cycle 1 closes

      assert.equal(await vault.read.getDepositStatus([bob.account.address, 0n]), STATUS.Ready);
      const before = await balance(bob.account.address);
      await vault.write.withdrawPrincipal([0n], { account: bob.account });
      assert.equal((await balance(bob.account.address)) - before, U(505));
    });
  });

  describe("losses", () => {
    it("shares a loss pro rata and leaves pending deposits untouched", async () => {
      const { vault, alice, bob, carol, balance } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(1000)], { account: alice.account });
      await vault.write.deposit([U(3000)], { account: bob.account });
      await vault.write.ownerWithdraw([U(4000)]);
      await vault.write.deposit([U(500)], { account: carol.account }); // pending during the loss

      await vault.write.ownerCloseCycleWithLoss([U(3000)]); // 25% loss
      assert.equal(await vault.read.cycleLoss([1n]), U(1000));
      assert.equal(await vault.read.principalOf([alice.account.address, 0n]), U(750));
      assert.equal(await vault.read.principalOf([bob.account.address, 0n]), U(2250));
      assert.equal(await vault.read.principalOf([carol.account.address, 0n]), U(500));

      // Carol joins after the loss at the lower share price and keeps her 500 (less at most
      // 1 micro-USDT of rounding, always in the vault's favour).
      const deployable = await vault.read.ownerWithdrawable();
      assertClose(deployable, U(3500), 1n, "deployable after loss");
      await vault.write.ownerWithdraw([deployable]);
      assertClose(await vault.read.principalOf([carol.account.address, 0n]), U(500), 1n, "Carol after joining");

      // Profit is shared by current principal: 750 : 2250 : 500.
      await vault.write.distributeProfit([U(35)]);
      assertClose(await vault.read.pendingProfit([alice.account.address, 0n]), U(7.5), 1n, "Alice");
      assertClose(await vault.read.pendingProfit([bob.account.address, 0n]), U(22.5), 1n, "Bob");
      assertClose(await vault.read.pendingProfit([carol.account.address, 0n]), U(5), 1n, "Carol");

      await vault.write.ownerReturnPrincipal([deployable]);
      const before = await balance(alice.account.address);
      await vault.write.withdrawPrincipal([0n], { account: alice.account });
      assertClose((await balance(alice.account.address)) - before, U(757.5), 1n, "Alice exit");
    });

    it("only writes off what was deployed when part of the principal stayed in the vault", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(1000)], { account: alice.account });
      await vault.write.ownerWithdraw([U(400)]);
      await vault.write.ownerCloseCycleWithLoss([U(100)]); // lose 300 of the 400 deployed
      assert.equal(await vault.read.principalOf([alice.account.address, 0n]), U(700));
      await vault.write.withdrawPrincipal([0n], { account: alice.account });
    });

    it("rejects a 'loss' call when there's no loss or no open cycle, and a total wipe-out", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(baseFixture);
      await expectRevert(vault.write.ownerCloseCycleWithLoss([0n]), "No open cycle");
      await vault.write.deposit([U(1000)], { account: alice.account });
      await vault.write.ownerWithdraw([U(1000)]);
      await expectRevert(vault.write.ownerCloseCycleWithLoss([U(1000)]), "No loss");
      await expectRevert(vault.write.ownerCloseCycleWithLoss([0n]), "Loss would wipe out all principal");
      await vault.write.ownerCloseCycleWithLoss([1n]); // total loss: return 1 unit
      assert.equal(await vault.read.principalOf([alice.account.address, 0n]), 1n);
    });
  });

  describe("presale integration", () => {
    it("records presale buys as pending deposits and issues SLF", async () => {
      const { vault, token, usdt, alice } = await networkHelpers.loadFixture(baseFixture);
      await token.write.buy([U(100)], { account: alice.account });
      assert.equal(await vault.read.pendingPrincipal(), U(100));
      assert.equal(await usdt.read.balanceOf([vault.address]), U(100));
      assert.equal(await token.read.balanceOf([alice.account.address]), parseUnits("1000", 18));
      const [d] = await vault.read.getUserDeposits([alice.account.address]);
      assert.equal(d.amount, U(100));
    });

    it("issues SLF for direct deposits while the presale is active", async () => {
      const { vault, token, bob } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(50)], { account: bob.account });
      assert.equal(await token.read.balanceOf([bob.account.address]), parseUnits("500", 18));
      assert.equal(await token.read.totalRaised(), U(50));
    });

    it("rejects recordDepositFrom from anyone but the presale, and from a presale that didn't pay", async () => {
      const { vault, alice } = await networkHelpers.loadFixture(baseFixture);
      await expectRevert(
        vault.write.recordDepositFrom([alice.account.address, U(100)], { account: alice.account }),
        "Caller is not the presale",
      );
      const fake = await viem.deployContract("FakePresale");
      await vault.write.setPresaleContract([fake.address]);
      await expectRevert(
        fake.write.recordWithoutPaying([vault.address, alice.account.address, U(100)]),
        "USDT not received",
      );
    });
  });

  describe("mainnet USDT behaviour", () => {
    it("runs the whole lifecycle with a token that returns nothing and has strict approvals", async () => {
      const { owner, alice } = await networkHelpers.loadFixture(baseFixture);
      const tether = await viem.deployContract("MockTetherUSDT");
      const vault = await viem.deployContract("VaultContractV2", [tether.address, owner.account.address]);

      await tether.write.mint([alice.account.address, U(1000)]);
      await tether.write.mint([owner.account.address, U(1000)]);
      await tether.write.approve([vault.address, U(1000)], { account: alice.account });
      await expectRevert(
        tether.write.approve([vault.address, U(5)], { account: alice.account }),
        "reset allowance to 0 first",
      );
      await tether.write.approve([vault.address, U(10_000)]);

      await vault.write.deposit([U(1000)], { account: alice.account });
      await vault.write.ownerWithdraw([U(1000)]);
      await vault.write.distributeProfit([U(20)]);
      await vault.write.withdrawProfit([0n], { account: alice.account });
      await vault.write.ownerReturnPrincipal([U(1000)]);
      await vault.write.withdrawPrincipal([0n], { account: alice.account });
      assert.equal(await tether.read.balanceOf([alice.account.address]), U(1020));
    });
  });

  describe("admin", () => {
    it("pause blocks users but not the owner", async () => {
      const { vault, token, alice } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(1000)], { account: alice.account });
      await vault.write.ownerWithdraw([U(1000)]);
      await vault.write.distributeProfit([U(10)]);
      await vault.write.pause();

      await expectRevert(vault.write.deposit([U(1)], { account: alice.account }), "Vault is paused");
      await expectRevert(vault.write.withdrawProfit([0n], { account: alice.account }), "Vault is paused");
      await expectRevert(token.write.buy([U(10)], { account: alice.account }), "Vault is paused");
      await vault.write.ownerReturnPrincipal([U(1000)]);
      await vault.write.distributeProfit([U(10)]);
      await expectRevert(vault.write.withdrawPrincipal([0n], { account: alice.account }), "Vault is paused");

      await vault.write.unpause();
      await vault.write.withdrawPrincipal([0n], { account: alice.account });
    });

    it("sweeps only USDT that belongs to nobody", async () => {
      const { vault, usdt, alice, owner, balance } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.deposit([U(1000)], { account: alice.account });
      await vault.write.ownerWithdraw([U(1000)]);
      await vault.write.distributeProfit([U(10)]);
      await vault.write.ownerReturnPrincipal([U(1000)]);
      await expectRevert(vault.write.sweepSurplus(), "No surplus");

      await usdt.write.transfer([vault.address, U(5)], { account: alice.account });
      assert.equal(await vault.read.surplus(), U(5));
      const before = await balance(owner.account.address);
      await vault.write.sweepSurplus();
      assert.equal((await balance(owner.account.address)) - before, U(5));
      await vault.write.withdrawPrincipal([0n], { account: alice.account });
    });

    it("migrates v1 positions without issuing SLF, then locks migration for good", async () => {
      const { vault, token, alice, bob } = await networkHelpers.loadFixture(baseFixture);
      await vault.write.migrateDeposits([[alice.account.address, bob.account.address], [U(4), U(1005)]]);
      assert.equal(await vault.read.pendingPrincipal(), U(1009));
      assert.equal(await token.read.balanceOf([bob.account.address]), 0n);
      const [d] = await vault.read.getUserDeposits([bob.account.address]);
      assert.equal(d.amount, U(1005));

      await vault.write.finalizeMigration();
      await expectRevert(vault.write.migrateDeposits([[alice.account.address], [U(1)]]), "Migration finalized");
    });
  });

  describe("solvency under random operations", () => {
    // SOLVENCY_SEEDS="1,2,3" SOLVENCY_STEPS=400 runs a heavier sweep locally.
    const seeds = (process.env.SOLVENCY_SEEDS ?? "1").split(",").map((x) => BigInt(x.trim()));
    const steps = Number(process.env.SOLVENCY_STEPS ?? "250");

    for (const runSeed of seeds) it(`always holds enough USDT and lets everyone exit in full (seed ${runSeed})`, async () => {
      const { vault, usdt, wallets } = await networkHelpers.loadFixture(baseFixture);
      const users = wallets.slice(1, 7);
      for (const u of users.slice(4)) {
        await usdt.write.mint([u.account.address, U(1_000_000)]);
        await usdt.write.approve([vault.address, U(1_000_000_000)], { account: u.account });
      }

      let seed = 0x5eed1234n + runSeed * 7919n;
      const rand = (n: bigint) => {
        seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
        return (seed >> 33n) % n;
      };

      const deposited = new Map<string, bigint>();
      let totalProfit = 0n;
      let totalLoss = 0n;

      for (let step = 0; step < steps; step++) {
        const op = rand(8n);
        const user = users[Number(rand(BigInt(users.length)))];
        const deployed = await vault.read.deployedPrincipal();
        try {
          if (op <= 1n) {
            const amt = rand(U(5000)) + 1n;
            await vault.write.deposit([amt], { account: user.account });
            deposited.set(user.account.address, (deposited.get(user.account.address) ?? 0n) + amt);
          } else if (op === 2n) {
            const max = await vault.read.ownerWithdrawable();
            if (max > 0n) await vault.write.ownerWithdraw([rand(max) + 1n]);
          } else if (op === 3n) {
            if ((await vault.read.totalShares()) > 0n) {
              const amt = rand(U(200)) + U(1);
              await vault.write.distributeProfit([amt]);
              totalProfit += amt;
            }
          } else if (op === 4n) {
            if (deployed > 0n) {
              const amt = rand(2n) === 0n ? deployed : rand(deployed) + 1n;
              await vault.write.ownerReturnPrincipal([amt]);
            }
          } else if (op === 5n) {
            if (deployed > 0n && rand(3n) === 0n) {
              const active = await vault.read.activePrincipal();
              const maxLoss = deployed < active - 1n ? deployed : active - 1n;
              const loss = rand(maxLoss / 10n + 1n); // up to ~10% of what's deployed
              await vault.write.ownerCloseCycleWithLoss([deployed - loss]);
              totalLoss += loss;
            }
          } else if (op === 6n) {
            const list = await vault.read.getUserDeposits([user.account.address]);
            if (list.length > 0) {
              const i = rand(BigInt(list.length));
              if ((await vault.read.pendingProfit([user.account.address, i])) > 0n) {
                await vault.write.withdrawProfit([i], { account: user.account });
              }
            }
          } else {
            const list = await vault.read.getUserDeposits([user.account.address]);
            if (list.length > 0) {
              const i = rand(BigInt(list.length));
              if (await vault.read.isDepositUnlocked([user.account.address, i])) {
                await vault.write.withdrawPrincipal([i], { account: user.account });
              }
            }
          }
        } catch (err) {
          assert.fail(`step ${step} op ${op} reverted unexpectedly: ${String(err).slice(0, 400)}`);
        }
        await assertSolvent(vault, usdt);
      }

      // Wind down: return everything still deployed, run one more full cycle so every
      // deposit has completed a cycle, then every deposit exits.
      const deployed = await vault.read.deployedPrincipal();
      if (deployed > 0n) await vault.write.ownerReturnPrincipal([deployed]);
      const last = await vault.read.ownerWithdrawable();
      if (last > 0n) {
        await vault.write.ownerWithdraw([last]);
        await vault.write.ownerReturnPrincipal([last]);
      }

      for (const u of users) {
        const list = await vault.read.getUserDeposits([u.account.address]);
        for (let i = 0n; i < BigInt(list.length); i++) {
          if (!list[Number(i)].principalWithdrawn) {
            await vault.write.withdrawPrincipal([i], { account: u.account });
          }
        }
        await assertSolvent(vault, usdt);
      }

      const leftoverActive = await vault.read.activePrincipal();
      assert.ok(leftoverActive <= 1n, `only rounding dust may remain active, got ${leftoverActive}`);
      assert.equal(await vault.read.pendingPrincipal(), 0n);
      const leftover = await usdt.read.balanceOf([vault.address]);
      assert.ok(leftover < U(0.01), `leftover in vault should be dust, got ${leftover}`);
      assert.ok(totalProfit > 0n && totalLoss >= 0n);
    });
  });
});
