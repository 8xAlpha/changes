import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";

const { viem, networkHelpers } = await hre.network.connect();

const TOTAL_SUPPLY = 200_000_000n * 10n ** 18n;
const PRESALE_SUPPLY = 110_000_000n * 10n ** 18n;
const LIQUIDITY_SUPPLY = 40_000_000n * 10n ** 18n;
const TREASURY_SUPPLY = 10_000_000n * 10n ** 18n;
const TEAM_SUPPLY = 30_000_000n * 10n ** 18n;
const MARKETING_SUPPLY = 10_000_000n * 10n ** 18n;

const HARD_CAP = 11_000_000n * 10n ** 6n;
/** Matches `PRICE_IN_USDT = 1e5` in Token.sol */
const PRICE_IN_USDT = 10n ** 5n;

const USDT_ADDRESS = "0xC82d39eAB653a7eC66d1B017d7CB1ea4aC9E6e9e";

async function deployFixture() {
  const wallets = await viem.getWalletClients();
  assert.ok(wallets && wallets.length >= 8, "need at least 8 wallets");

  const [owner, liquidity, treasury, team, marketing, buyer, other, extra] = wallets;

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

  return {
    presale,
    mockUsdt,
    vault,
    owner,
    liquidity,
    treasury,
    team,
    marketing,
    buyer,
    other,
    extra,
  };
}

async function deployUnlinkedFixture() {
  const wallets = await viem.getWalletClients();
  const [owner, liquidity, treasury, team, marketing, buyer] = wallets;
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
  return { presale, vault, mockUsdt, owner, buyer };
}

function tokensForUsdt(usdtAmount: bigint) {
  return (usdtAmount * 10n ** 18n) / PRICE_IN_USDT;
}

describe("ProjectTokenPresale", function () {
  describe("deployment", function () {
    it("mints full supply and distributes non-presale allocations", async function () {
      const { presale, liquidity, treasury, team, marketing } =
        await networkHelpers.loadFixture(deployFixture);

      assert.equal(await presale.read.TOTAL_SUPPLY(), TOTAL_SUPPLY);
      assert.equal(await presale.read.PRESALE_SUPPLY(), PRESALE_SUPPLY);
      assert.equal(await presale.read.balanceOf([presale.address]), PRESALE_SUPPLY);
      assert.equal(await presale.read.remainingPresaleTokens(), PRESALE_SUPPLY);
      assert.equal(await presale.read.balanceOf([liquidity.account.address]), LIQUIDITY_SUPPLY);
      assert.equal(await presale.read.balanceOf([treasury.account.address]), TREASURY_SUPPLY);
      assert.equal(await presale.read.balanceOf([team.account.address]), TEAM_SUPPLY);
      assert.equal(await presale.read.balanceOf([marketing.account.address]), MARKETING_SUPPLY);
      assert.equal(await presale.read.HARD_CAP(), HARD_CAP);
      assert.equal(await presale.read.remainingCap(), HARD_CAP);
      assert.equal(await presale.read.presaleActive(), true);
      assert.equal(await presale.read.totalRaised(), 0n);
    });
  });

  describe("buy (positive)", function () {
    it("mints correct tokens and forwards USDT to vault + totalRaised", async function () {
      const { presale, mockUsdt, buyer, vault } = await networkHelpers.loadFixture(deployFixture);
      const payAmount = 100n * 10n ** 6n;
      await mockUsdt.write.mint([buyer.account.address, payAmount]);
      await mockUsdt.write.approve([presale.address, payAmount], { account: buyer.account });
      await presale.write.buy([payAmount], { account: buyer.account });

      const expected = tokensForUsdt(payAmount);
      assert.equal(await presale.read.balanceOf([buyer.account.address]), expected);
      assert.equal(await presale.read.totalRaised(), payAmount);
      assert.equal(await mockUsdt.read.balanceOf([vault.address]), payAmount);
    });

    it("accumulates multiple buys and reduces remainingPresaleTokens", async function () {
      const { presale, mockUsdt, buyer } = await networkHelpers.loadFixture(deployFixture);
      const chunk = 50n * 10n ** 6n;
      const totalPay = chunk * 2n;
      await mockUsdt.write.mint([buyer.account.address, totalPay]);
      await mockUsdt.write.approve([presale.address, totalPay], { account: buyer.account });
      const before = await presale.read.remainingPresaleTokens();
      await presale.write.buy([chunk], { account: buyer.account });
      await presale.write.buy([chunk], { account: buyer.account });
      const bought = tokensForUsdt(totalPay);
      assert.equal(before - (await presale.read.remainingPresaleTokens()), bought);
      assert.equal(await presale.read.totalRaised(), totalPay);
    });

    it("previewPurchase matches buy outcome", async function () {
      const { presale, mockUsdt, buyer } = await networkHelpers.loadFixture(deployFixture);
      const payAmount = 250n * 10n ** 6n;
      const preview = await presale.read.previewPurchase([payAmount]);
      await mockUsdt.write.mint([buyer.account.address, payAmount]);
      await mockUsdt.write.approve([presale.address, payAmount], { account: buyer.account });
      await presale.write.buy([payAmount], { account: buyer.account });
      assert.equal(await presale.read.balanceOf([buyer.account.address]), preview);
    });

    it("hitting HARD_CAP in one buy ends presale", async function () {
      const { presale, mockUsdt, buyer } = await networkHelpers.loadFixture(deployFixture);
      await mockUsdt.write.mint([buyer.account.address, HARD_CAP]);
      await mockUsdt.write.approve([presale.address, HARD_CAP], { account: buyer.account });
      await presale.write.buy([HARD_CAP], { account: buyer.account });
      assert.equal(await presale.read.presaleActive(), false);
      assert.equal(await presale.read.totalRaised(), HARD_CAP);
      assert.equal(await presale.read.remainingCap(), 0n);
    });
  });

  describe("buy (negative)", function () {
    it("reverts when vault not linked", async function () {
      const { presale, mockUsdt, buyer } = await networkHelpers.loadFixture(deployUnlinkedFixture);
      const pay = 10n * 10n ** 6n;
      await mockUsdt.write.mint([buyer.account.address, pay]);
      await mockUsdt.write.approve([presale.address, pay], { account: buyer.account });
      await assert.rejects(
        () => presale.write.buy([pay], { account: buyer.account }),
        /Vault not linked yet/
      );
    });

    it("reverts below minBuy", async function () {
      const { presale, buyer } = await networkHelpers.loadFixture(deployFixture);
      await assert.rejects(
        () => presale.write.buy([0n], { account: buyer.account }),
        /Below minimum buy amount/
      );
    });

    it("reverts when totalRaised + amount exceeds HARD_CAP", async function () {
      const { presale, mockUsdt, buyer } = await networkHelpers.loadFixture(deployFixture);
      const chunk = 100n * 10n ** 6n;
      const first = HARD_CAP - chunk;
      await mockUsdt.write.mint([buyer.account.address, HARD_CAP]);
      await mockUsdt.write.approve([presale.address, HARD_CAP], { account: buyer.account });
      await presale.write.buy([first], { account: buyer.account });
      await assert.rejects(
        () => presale.write.buy([chunk + 1n], { account: buyer.account }),
        /Hard cap reached/
      );
    });

    it("reverts when presale ended by owner", async function () {
      const { presale, mockUsdt, buyer, owner } = await networkHelpers.loadFixture(deployFixture);
      await presale.write.endPresale({ account: owner.account });
      const pay = 10n * 10n ** 6n;
      await mockUsdt.write.mint([buyer.account.address, pay]);
      await mockUsdt.write.approve([presale.address, pay], { account: buyer.account });
      await assert.rejects(
        () => presale.write.buy([pay], { account: buyer.account }),
        /Presale has ended/
      );
    });

    it("issueTokensForDeposit: hard cap then presale ended (supply lines up with cap)", async function () {
      const wallets = await viem.getWalletClients();
      const [owner, liquidity, treasury, team, marketing, user] = wallets;
      const mockUsdtArtifact = await hre.artifacts.readArtifact("MockUSDT");
      await networkHelpers.setCode(USDT_ADDRESS, mockUsdtArtifact.deployedBytecode);

      const presale = await viem.deployContract("ProjectTokenPresale", [
        "T",
        "T",
        liquidity.account.address,
        treasury.account.address,
        team.account.address,
        marketing.account.address,
        USDT_ADDRESS,
      ] as const);
      const helper = await viem.deployContract("TokenIssueHelper", []);
      await presale.write.setVaultContract([helper.address], { account: owner.account });

      const cap = await presale.read.HARD_CAP();
      await helper.write.issue([presale.address, user.account.address, cap - 1n]);
      await assert.rejects(
        () => helper.write.issue([presale.address, user.account.address, 2n]),
        /Hard cap reached/
      );
      await helper.write.issue([presale.address, user.account.address, 1n]);
      assert.equal(await presale.read.totalRaised(), cap);
      assert.equal(await presale.read.presaleActive(), false);
      assert.equal(await presale.read.remainingPresaleTokens(), 0n);
      await assert.rejects(
        () => helper.write.issue([presale.address, user.account.address, 1n]),
        /Presale has ended/
      );
    });
  });

  describe("setVaultContract", function () {
    it("reverts zero address and non-contract", async function () {
      const { presale, owner, other } = await networkHelpers.loadFixture(deployFixture);
      await assert.rejects(
        () =>
          presale.write.setVaultContract([`0x${"0".repeat(40)}` as `0x${string}`], {
            account: owner.account,
          }),
        /Zero address/
      );
      await assert.rejects(
        () => presale.write.setVaultContract([other.account.address], { account: owner.account }),
        /Vault must be a contract/
      );
    });

    it("non-owner cannot set vault", async function () {
      const { presale, buyer, vault } = await networkHelpers.loadFixture(deployFixture);
      await assert.rejects(
        () => presale.write.setVaultContract([vault.address], { account: buyer.account }),
        /OwnableUnauthorizedAccount|not the owner/i
      );
    });
  });

  describe("issueTokensForDeposit (vault-only)", function () {
    it("vault deposit mints presale tokens while active", async function () {
      const { vault, presale, mockUsdt, buyer } = await networkHelpers.loadFixture(deployFixture);
      const amount = 80n * 10n ** 6n;
      await mockUsdt.write.mint([buyer.account.address, amount]);
      await mockUsdt.write.approve([vault.address, amount], { account: buyer.account });
      const before = await presale.read.balanceOf([buyer.account.address]);
      await vault.write.deposit([amount], { account: buyer.account });
      assert.equal(
        (await presale.read.balanceOf([buyer.account.address])) - before,
        tokensForUsdt(amount)
      );
      assert.equal(await presale.read.totalRaised(), amount);
    });

    it("non-vault cannot call issueTokensForDeposit", async function () {
      const { presale, mockUsdt, buyer, other } = await networkHelpers.loadFixture(deployFixture);
      const amt = 10n * 10n ** 6n;
      await mockUsdt.write.mint([buyer.account.address, amt]);
      await assert.rejects(
        () =>
          presale.write.issueTokensForDeposit([other.account.address, amt], {
            account: buyer.account,
          }),
        /Caller is not the vault/
      );
    });

    it("reverts issueTokensForDeposit when presale inactive (helper as vault)", async function () {
      const wallets = await viem.getWalletClients();
      const [owner, liquidity, treasury, team, marketing, user] = wallets;
      const mockUsdtArtifact = await hre.artifacts.readArtifact("MockUSDT");
      await networkHelpers.setCode(USDT_ADDRESS, mockUsdtArtifact.deployedBytecode);

      const presale = await viem.deployContract("ProjectTokenPresale", [
        "T",
        "T",
        liquidity.account.address,
        treasury.account.address,
        team.account.address,
        marketing.account.address,
        USDT_ADDRESS,
      ] as const);
      const helper = await viem.deployContract("TokenIssueHelper", []);
      await presale.write.setVaultContract([helper.address], { account: owner.account });
      await presale.write.endPresale({ account: owner.account });

      await assert.rejects(
        () =>
          helper.write.issue([
            presale.address,
            user.account.address,
            10n ** 6n,
          ]),
        /Presale has ended/
      );
    });
  });

  describe("setMinBuy", function () {
    it("updates minBuy", async function () {
      const { presale, owner, mockUsdt, buyer } = await networkHelpers.loadFixture(deployFixture);
      const newMin = 5n * 10n ** 6n;
      await presale.write.setMinBuy([newMin], { account: owner.account });
      assert.equal(await presale.read.minBuy(), newMin);
      await mockUsdt.write.mint([buyer.account.address, newMin - 1n]);
      await mockUsdt.write.approve([presale.address, newMin - 1n], { account: buyer.account });
      await assert.rejects(
        () => presale.write.buy([newMin - 1n], { account: buyer.account }),
        /Below minimum buy amount/
      );
    });

    it("reverts minBuy zero", async function () {
      const { presale, owner } = await networkHelpers.loadFixture(deployFixture);
      await assert.rejects(
        () => presale.write.setMinBuy([0n], { account: owner.account }),
        /Min buy must be > 0/
      );
    });
  });

  describe("owner: endPresale & burnUnsoldTokens", function () {
    it("burnUnsoldTokens only after presale ended; records UNSOLD", async function () {
      const { presale, owner } = await networkHelpers.loadFixture(deployFixture);
      const unsold = await presale.read.remainingPresaleTokens();
      await presale.write.endPresale({ account: owner.account });
      await presale.write.burnUnsoldTokens([unsold], { account: owner.account });
      assert.equal(await presale.read.remainingPresaleTokens(), 0n);
      const history = await presale.read.getBurnHistory();
      const last = history[history.length - 1] as { burnType: string; amount: bigint };
      assert.equal(last.burnType, "UNSOLD");
      assert.equal(last.amount, unsold);
      assert.equal(await presale.read.totalBurned(), unsold);
    });

    it("reverts burnUnsoldTokens while presale still active", async function () {
      const { presale, owner } = await networkHelpers.loadFixture(deployFixture);
      const unsold = await presale.read.remainingPresaleTokens();
      await assert.rejects(
        () => presale.write.burnUnsoldTokens([unsold], { account: owner.account }),
        /Presale still active/
      );
    });

    it("reverts burn when no unsold left", async function () {
      const { presale, owner } = await networkHelpers.loadFixture(deployFixture);
      const unsold = await presale.read.remainingPresaleTokens();
      await presale.write.endPresale({ account: owner.account });
      await presale.write.burnUnsoldTokens([unsold], { account: owner.account });
      await assert.rejects(
        () => presale.write.burnUnsoldTokens([1n], { account: owner.account }),
        /No unsold presale tokens/
      );
    });

    it("non-owner cannot burnUnsoldTokens", async function () {
      const { presale, owner, other } = await networkHelpers.loadFixture(deployFixture);
      await presale.write.endPresale({ account: owner.account });
      await assert.rejects(
        () => presale.write.burnUnsoldTokens([1n], { account: other.account }),
        /OwnableUnauthorizedAccount|not the owner/i
      );
    });
  });

  describe("user burns", function () {
    it("burn and burnFrom append USER / APPROVED history", async function () {
      const { presale, mockUsdt, buyer, other } = await networkHelpers.loadFixture(deployFixture);
      const pay = 100n * 10n ** 6n;
      await mockUsdt.write.mint([buyer.account.address, pay]);
      await mockUsdt.write.approve([presale.address, pay], { account: buyer.account });
      await presale.write.buy([pay], { account: buyer.account });
      const bal = await presale.read.balanceOf([buyer.account.address]);
      const half = bal / 2n;
      await presale.write.burn([half], { account: buyer.account });
      await presale.write.approve([other.account.address, half], { account: buyer.account });
      await presale.write.burnFrom([buyer.account.address, half], { account: other.account });
      const history = await presale.read.getBurnHistory();
      const a = history[history.length - 2] as { burnType: string };
      const b = history[history.length - 1] as { burnType: string };
      assert.equal(a.burnType, "USER");
      assert.equal(b.burnType, "APPROVED");
      assert.equal(await presale.read.getBurnedThisMonth(), half + half);
    });
  });
});
