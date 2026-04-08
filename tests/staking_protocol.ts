import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { StakingProtocol } from "../target/types/staking_protocol";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
    createMint,
    createAssociatedTokenAccount,
    getOrCreateAssociatedTokenAccount,
    mintTo,
    getAccount,
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

// ─────────────────────────────────────────────────────────────────────────────
// Constants — keep in sync with your program's constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_REWARD_RATE = 1_000_000_000; // must match your Rust MAX_REWARD_RATE constant

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getTokenBalance(
    provider: anchor.AnchorProvider,
    ata: PublicKey
): Promise<bigint> {
    const account = await getAccount(provider.connection, ata);
    return account.amount;
}

function randomSeed(): BN {
    return new BN(Math.floor(Math.random() * 1_000_000_000));
}

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function assertFails(promise: Promise<unknown>, substring: string): Promise<void> {
    try {
        await promise;
        assert.fail(`Expected failure with "${substring}" but succeeded`);
    } catch (err: any) {
        if (err?.message?.includes("assert.fail")) throw err;
        const msg = err?.message ?? err?.toString() ?? "";
        assert.include(msg, substring, `Expected "${substring}" in: ${msg}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("staking", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.StakingProtocol as Program<StakingProtocol>;
    const wallet = provider.wallet as anchor.Wallet;

    let stakeMint: PublicKey;
    let userAtaStake: PublicKey;

    const FEE_BPS = 500;
    const LOCK_DURATION = new BN(30);
    const REWARD_RATE = new BN(1_000_000_000);

    before("create stake mint and fund user", async () => {
        stakeMint = await createMint(
            provider.connection,
            wallet.payer,
            wallet.publicKey,
            null,
            6
        );

        userAtaStake = await createAssociatedTokenAccount(
            provider.connection,
            wallet.payer,
            stakeMint,
            wallet.publicKey
        );

        await mintTo(
            provider.connection,
            wallet.payer,
            stakeMint,
            userAtaStake,
            wallet.payer,
            // Mint enough for all test suites including large-amount security tests
            1_000_000_000_000
        );
    });

    // ── Shared helpers ────────────────────────────────────────────────────────

    async function setupPool(seed: BN, rewardRate: BN = REWARD_RATE, feeBps: BN = new BN(FEE_BPS)) {
        const [pool] = PublicKey.findProgramAddressSync(
            [Buffer.from("stakepool"), wallet.publicKey.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
            program.programId
        );
        const [rewardMint] = PublicKey.findProgramAddressSync(
            [Buffer.from("rp"), pool.toBuffer()],
            program.programId
        );

        await program.methods
            .initialize(seed, feeBps, LOCK_DURATION, rewardRate)
            .accountsPartial({
                owner: wallet.publicKey,
                pool,
                stakeMint,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();

        const stakeVault = (await getOrCreateAssociatedTokenAccount(
            provider.connection, wallet.payer, stakeMint, pool, true
        )).address;
        const rewardVault = (await getOrCreateAssociatedTokenAccount(
            provider.connection, wallet.payer, rewardMint, pool, true
        )).address;

        return { pool, rewardMint, stakeVault, rewardVault };
    }

    async function setupUserRewardAta(rewardMint: PublicKey): Promise<PublicKey> {
        return (await getOrCreateAssociatedTokenAccount(
            provider.connection, wallet.payer, rewardMint, wallet.publicKey
        )).address;
    }

    /**
     * Routes to initializeStake or addStake depending on whether
     * the stake_entry PDA already exists (Option A split instruction pattern).
     *
     * Pass null (or omit) for the wallet's own payer. Pass an explicit Keypair
     * for attacker / secondary-user scenarios. This avoids the Wallet→Keypair
     * type incompatibility: wallet.payer is already a Keypair; generated
     * attackers are already Keypairs. No cast is ever needed.
     */
    async function stakeTokens(
        amount: BN,
        pool: PublicKey,
        stakeVault: PublicKey,
        user: Keypair | null = null
    ) {
        const signer: Keypair = user ?? wallet.payer;
        const signerKey = signer.publicKey;
        const isWallet = signerKey.equals(wallet.publicKey);

        const [stakeEntryPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("stakeentry"), pool.toBuffer(), signerKey.toBuffer()],
            program.programId
        );

        const userAta = isWallet
            ? userAtaStake
            : (await getOrCreateAssociatedTokenAccount(
                provider.connection, wallet.payer, stakeMint, signerKey
            )).address;

        const accountInfo = await provider.connection.getAccountInfo(stakeEntryPda);

        if (accountInfo === null) {
            await program.methods
                .initializeStake(amount)
                .accountsPartial({
                    user: signerKey,
                    pool,
                    stakeMint,
                    stakeVault,
                    userAtaStake: userAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers(isWallet ? [] : [signer])
                .rpc();
        } else {
            await program.methods
                .addStake(amount)
                .accountsPartial({
                    owner: signerKey,
                    pool,
                    stakeMint,
                    stakeVault,
                    userAtaStake: userAta,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers(isWallet ? [] : [signer])
                .rpc();
        }
    }

    async function getStakeEntryAddress(pool: PublicKey, user = wallet.publicKey): Promise<PublicKey> {
        const [stakeEntry] = PublicKey.findProgramAddressSync(
            [Buffer.from("stakeentry"), pool.toBuffer(), user.toBuffer()],
            program.programId
        );
        return stakeEntry;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Initialize
    // ─────────────────────────────────────────────────────────────────────────
    describe("initialize", () => {
        let pool: PublicKey;
        let rewardMint: PublicKey;
        let stakeVault: PublicKey;
        let rewardVault: PublicKey;
        const seed = randomSeed();

        before(async () => {
            const result = await setupPool(seed);
            pool = result.pool;
            rewardMint = result.rewardMint;
            stakeVault = result.stakeVault;
            rewardVault = result.rewardVault;
        });

        it("creates pool with correct state", async () => {
            const poolState = await program.account.stakePool.fetch(pool);
            assert.equal(poolState.owner.toBase58(), wallet.publicKey.toBase58());
            assert.equal(poolState.stakeMint.toBase58(), stakeMint.toBase58());
            assert.equal(poolState.rewardMint.toBase58(), rewardMint.toBase58());
            assert.equal(poolState.stakeVault.toBase58(), stakeVault.toBase58());
            assert.equal(poolState.feeBps.toString(), FEE_BPS.toString());
            assert.equal(poolState.lockDuration.toString(), LOCK_DURATION.toString());
            assert.equal(poolState.rewardRate.toString(), REWARD_RATE.toString());
            assert.equal(poolState.totalStaked.toString(), "0");
            // Pause state must be false at init
            assert.isFalse(poolState.isPaused);
        });

        it("rejects fee_bps >= 10000", async () => {
            const badSeed = randomSeed();
            const [badPool] = PublicKey.findProgramAddressSync(
                [Buffer.from("stakepool"), wallet.publicKey.toBuffer(), badSeed.toArrayLike(Buffer, "le", 8)],
                program.programId
            );

            await assertFails(
                program.methods
                    .initialize(badSeed, new BN(10_000), LOCK_DURATION, REWARD_RATE)
                    .accountsPartial({
                        owner: wallet.publicKey,
                        pool: badPool,
                        stakeMint,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc(),
                "InvalidFee"
            );
        });

        it("rejects zero reward_rate", async () => {
            const badSeed = randomSeed();
            const [badPool] = PublicKey.findProgramAddressSync(
                [Buffer.from("stakepool"), wallet.publicKey.toBuffer(), badSeed.toArrayLike(Buffer, "le", 8)],
                program.programId
            );

            await assertFails(
                program.methods
                    .initialize(badSeed, new BN(FEE_BPS), LOCK_DURATION, new BN(0))
                    .accountsPartial({
                        owner: wallet.publicKey,
                        pool: badPool,
                        stakeMint,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc(),
                "InvalidAmount"
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Stake
    // ─────────────────────────────────────────────────────────────────────────
    describe("stake", () => {
        let pool: PublicKey;
        let stakeVault: PublicKey;
        let stakeEntry: PublicKey;
        const seed = randomSeed();

        before(async () => {
            const result = await setupPool(seed);
            pool = result.pool;
            stakeVault = result.stakeVault;
            stakeEntry = await getStakeEntryAddress(pool);
        });

        it("first stake initializes entry correctly (initializeStake)", async () => {
            const amount = new BN(1_000_000);
            await stakeTokens(amount, pool, stakeVault);

            const entry = await program.account.stakeEntry.fetch(stakeEntry);
            assert.equal(entry.owner.toBase58(), wallet.publicKey.toBase58());
            assert.equal(entry.pool.toBase58(), pool.toBase58());
            assert.equal(entry.amountStaked.toString(), amount.toString());
            assert.equal(entry.rewardsEarned.toString(), "0");
            assert.isTrue(entry.stakeStartTime.toNumber() > 0);
            assert.isTrue(entry.lastUpdateTime.toNumber() > 0);
        });

        it("subsequent stake accumulates amount correctly (addStake)", async () => {
            const additionalAmount = new BN(500_000);
            const entryBefore = await program.account.stakeEntry.fetch(stakeEntry);
            const stakedBefore = entryBefore.amountStaked;

            await stakeTokens(additionalAmount, pool, stakeVault);

            const entryAfter = await program.account.stakeEntry.fetch(stakeEntry);
            assert.equal(
                entryAfter.amountStaked.toString(),
                stakedBefore.add(additionalAmount).toString()
            );
        });

        it("increments pool total_staked", async () => {
            const poolBefore = await program.account.stakePool.fetch(pool);
            const amount = new BN(100_000);

            await stakeTokens(amount, pool, stakeVault);

            const poolAfter = await program.account.stakePool.fetch(pool);
            assert.equal(
                poolAfter.totalStaked.sub(poolBefore.totalStaked).toString(),
                amount.toString()
            );
        });

        it("transfers tokens from user to vault", async () => {
            const userBalBefore = await getTokenBalance(provider, userAtaStake);
            const vaultBalBefore = await getTokenBalance(provider, stakeVault);
            const amount = new BN(200_000);

            await stakeTokens(amount, pool, stakeVault);

            const userBalAfter = await getTokenBalance(provider, userAtaStake);
            const vaultBalAfter = await getTokenBalance(provider, stakeVault);

            assert.equal(userBalBefore - userBalAfter, BigInt(amount.toNumber()));
            assert.equal(vaultBalAfter - vaultBalBefore, BigInt(amount.toNumber()));
        });

        it("rejects zero amount — initializeStake path", async () => {
            const zeroSeed = randomSeed();
            const { pool: zeroPool, stakeVault: zeroVault } = await setupPool(zeroSeed);

            await assertFails(
                program.methods
                    .initializeStake(new BN(0))
                    .accountsPartial({
                        user: wallet.publicKey,
                        pool: zeroPool,
                        stakeMint,
                        stakeVault: zeroVault,
                        userAtaStake,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc(),
                "InvalidAmount"
            );
        });

        it("rejects zero amount — addStake path", async () => {
            await assertFails(
                program.methods
                    .addStake(new BN(0))
                    .accountsPartial({
                        owner: wallet.publicKey,
                        pool,
                        stakeMint,
                        stakeVault,
                        userAtaStake,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc(),
                "InvalidAmount"
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Unstake
    // ─────────────────────────────────────────────────────────────────────────
    describe("unstake", () => {
        let pool: PublicKey;
        let stakeVault: PublicKey;
        let stakeEntry: PublicKey;
        const seed = randomSeed();
        const stakeAmount = new BN(1_000_000);

        before(async () => {
            const result = await setupPool(seed);
            pool = result.pool;
            stakeVault = result.stakeVault;
            stakeEntry = await getStakeEntryAddress(pool);

            await stakeTokens(stakeAmount, pool, stakeVault);
        });

        it("applies penalty when unstaking before lock period", async () => {
            const amount = new BN(500_000);
            const userBalBefore = await getTokenBalance(provider, userAtaStake);

            await program.methods
                .unstake(amount)
                .accountsPartial({
                    user: wallet.publicKey,
                    pool,
                    stakeMint,
                    stakeVault,
                    userAtaStake,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const userBalAfter = await getTokenBalance(provider, userAtaStake);
            const penalty = BigInt(amount.toNumber()) * BigInt(FEE_BPS) / 10_000n;
            const expectedOut = BigInt(amount.toNumber()) - penalty;

            assert.equal(userBalAfter - userBalBefore, expectedOut);
        });

        it("returns full amount after lock period expires", async () => {
            await sleep(32000);

            const entry = await program.account.stakeEntry.fetch(stakeEntry);
            const amountStaked = entry.amountStaked;
            const userBalBefore = await getTokenBalance(provider, userAtaStake);

            await program.methods
                .unstake(amountStaked)
                .accountsPartial({
                    user: wallet.publicKey,
                    pool,
                    stakeMint,
                    stakeVault,
                    userAtaStake,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const userBalAfter = await getTokenBalance(provider, userAtaStake);
            assert.equal(
                userBalAfter - userBalBefore,
                BigInt(amountStaked.toNumber())
            );
        });

        it("partial unstake leaves remaining balance", async () => {
            const freshAmount = new BN(1_000_000);
            await stakeTokens(freshAmount, pool, stakeVault);

            await sleep(32000);

            const partialAmount = new BN(400_000);
            await program.methods
                .unstake(partialAmount)
                .accountsPartial({
                    user: wallet.publicKey,
                    pool,
                    stakeMint,
                    stakeVault,
                    userAtaStake,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const entry = await program.account.stakeEntry.fetch(stakeEntry);
            assert.equal(
                entry.amountStaked.toString(),
                freshAmount.sub(partialAmount).toString()
            );
        });

        it("decrements pool total_staked", async () => {
            await sleep(32000);

            const poolBefore = await program.account.stakePool.fetch(pool);
            const unstakeAmount = new BN(100_000);

            await program.methods
                .unstake(unstakeAmount)
                .accountsPartial({
                    user: wallet.publicKey,
                    pool,
                    stakeMint,
                    stakeVault,
                    userAtaStake,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const poolAfter = await program.account.stakePool.fetch(pool);
            assert.equal(
                poolBefore.totalStaked.sub(poolAfter.totalStaked).toString(),
                unstakeAmount.toString()
            );
        });

        it("rejects zero amount", async () => {
            await assertFails(
                program.methods
                    .unstake(new BN(0))
                    .accountsPartial({
                        user: wallet.publicKey,
                        pool,
                        stakeMint,
                        stakeVault,
                        userAtaStake,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc(),
                "InvalidAmount"
            );
        });

        it("rejects amount exceeding staked balance", async () => {
            const entry = await program.account.stakeEntry.fetch(stakeEntry);
            const tooMuch = entry.amountStaked.addn(1);

            await assertFails(
                program.methods
                    .unstake(tooMuch)
                    .accountsPartial({
                        user: wallet.publicKey,
                        pool,
                        stakeMint,
                        stakeVault,
                        userAtaStake,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc(),
                "InsufficientStake"
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Claim Rewards
    // ─────────────────────────────────────────────────────────────────────────
    describe("claim_rewards", () => {
        let pool: PublicKey;
        let rewardMint: PublicKey;
        let stakeVault: PublicKey;
        let stakeEntry: PublicKey;
        let userAtaReward: PublicKey;
        const seed = randomSeed();
        const stakeAmount = new BN(1_000_000);

        before(async () => {
            const result = await setupPool(seed);
            pool = result.pool;
            rewardMint = result.rewardMint;
            stakeVault = result.stakeVault;
            stakeEntry = await getStakeEntryAddress(pool);
            userAtaReward = await setupUserRewardAta(rewardMint);

            await stakeTokens(stakeAmount, pool, stakeVault);
        });

        it("rejects claim when no rewards have accumulated yet", async () => {
            await assertFails(
                program.methods
                    .claimRewards()
                    .accountsPartial({
                        user: wallet.publicKey,
                        pool,
                        rewardMint,
                        userAtaReward,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc(),
                "NoRewards"
            );
        });

        it("mints correct reward amount after time passes", async () => {
            await sleep(3000);

            const rewardBalBefore = await getTokenBalance(provider, userAtaReward);

            await program.methods
                .claimRewards()
                .accountsPartial({
                    user: wallet.publicKey,
                    pool,
                    rewardMint,
                    userAtaReward,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const rewardBalAfter = await getTokenBalance(provider, userAtaReward);
            assert.isTrue(rewardBalAfter - rewardBalBefore > 0n);
        });

        it("zeros out rewards_earned after claim", async () => {
            await sleep(2000);

            await program.methods
                .claimRewards()
                .accountsPartial({
                    user: wallet.publicKey,
                    pool,
                    rewardMint,
                    userAtaReward,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const entry = await program.account.stakeEntry.fetch(stakeEntry);
            assert.equal(entry.rewardsEarned.toString(), "0");
        });

        it("rewards accumulate correctly across multiple stakes", async () => {
            await stakeTokens(new BN(500_000), pool, stakeVault);
            await sleep(2000);

            const rewardBalBefore = await getTokenBalance(provider, userAtaReward);

            await program.methods
                .claimRewards()
                .accountsPartial({
                    user: wallet.publicKey,
                    pool,
                    rewardMint,
                    userAtaReward,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const rewardBalAfter = await getTokenBalance(provider, userAtaReward);
            assert.isTrue(rewardBalAfter - rewardBalBefore > 0n);
        });

        it("last_update_time is reset after claim", async () => {
            await sleep(2000);

            const slotBefore = await provider.connection.getSlot();

            await program.methods
                .claimRewards()
                .accountsPartial({
                    user: wallet.publicKey,
                    pool,
                    rewardMint,
                    userAtaReward,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const entry = await program.account.stakeEntry.fetch(stakeEntry);
            const blockTime = await provider.connection.getBlockTime(slotBefore);

            assert.isTrue(entry.lastUpdateTime.toNumber() >= blockTime - 5);
        });

        it("rewards accumulate again after claiming", async () => {
            await sleep(2000);

            await program.methods
                .claimRewards()
                .accountsPartial({
                    user: wallet.publicKey,
                    pool,
                    rewardMint,
                    userAtaReward,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            await sleep(2000);

            const rewardBalBefore = await getTokenBalance(provider, userAtaReward);

            await program.methods
                .claimRewards()
                .accountsPartial({
                    user: wallet.publicKey,
                    pool,
                    rewardMint,
                    userAtaReward,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const rewardBalAfter = await getTokenBalance(provider, userAtaReward);
            assert.isTrue(rewardBalAfter - rewardBalBefore > 0n);
        });
    });

    // =========================================================================
    // SECURITY TESTS
    // =========================================================================

    // ─────────────────────────────────────────────────────────────────────────
    // F-01 🔴 Critical — Reward overflow protection (u64::try_from fix)
    // ─────────────────────────────────────────────────────────────────────────
    describe("F-01 — reward overflow protection", () => {
        let pool: PublicKey;
        let rewardMint: PublicKey;
        let stakeVault: PublicKey;
        let userAtaReward: PublicKey;
        const seed = randomSeed();

        const HIGH_REWARD_RATE = new BN(MAX_REWARD_RATE);
        const LARGE_STAKE = new BN(100_000_000_000);

        before(async () => {
            const result = await setupPool(seed, HIGH_REWARD_RATE);
            pool = result.pool;
            rewardMint = result.rewardMint;
            stakeVault = result.stakeVault;
            userAtaReward = await setupUserRewardAta(rewardMint);

            await stakeTokens(LARGE_STAKE, pool, stakeVault);
        });

        it("reward amount is positive and not silently truncated to zero", async () => {
            await sleep(3000);

            const before = await getTokenBalance(provider, userAtaReward);

            await program.methods
                .claimRewards()
                .accountsPartial({
                    user: wallet.publicKey,
                    pool,
                    rewardMint,
                    userAtaReward,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const after = await getTokenBalance(provider, userAtaReward);
            const minted = after - before;

            assert.isTrue(minted > 0n, "Expected positive reward — silent truncation would produce 0 or wrong value");

            const SCALE = 1_000_000_000n;
            const elapsedEstimate = 5n;
            const maxExpected = LARGE_STAKE.toNumber() * MAX_REWARD_RATE * Number(elapsedEstimate) / Number(SCALE);
            assert.isBelow(
                Number(minted),
                maxExpected * 2,
                "Reward is unreasonably large — possible overflow wrap-around"
            );
        });

        it("rewards_earned resets to zero after claim — confirms no phantom accumulation", async () => {
            const stakeEntry = await getStakeEntryAddress(pool);
            const entry = await program.account.stakeEntry.fetch(stakeEntry);
            assert.equal(entry.rewardsEarned.toString(), "0");
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // F-02 🟠 High — Withdraw penalties
    // ─────────────────────────────────────────────────────────────────────────
    describe("F-02 — withdraw penalties", () => {
        let pool: PublicKey;
        let stakeVault: PublicKey;
        const seed = randomSeed();
        const stakeAmount = new BN(1_000_000);

        before(async () => {
            const result = await setupPool(seed);
            pool = result.pool;
            stakeVault = result.stakeVault;

            await stakeTokens(stakeAmount, pool, stakeVault);
            await program.methods
                .unstake(stakeAmount)
                .accountsPartial({
                    user: wallet.publicKey,
                    pool,
                    stakeMint,
                    stakeVault,
                    userAtaStake,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();
        });

        it("accumulated_penalties is non-zero after early unstake", async () => {
            const poolState = await program.account.stakePool.fetch(pool);
            const expectedPenalty = stakeAmount.toNumber() * FEE_BPS / 10_000;
            assert.equal(
                poolState.accumulatedPenalties.toString(),
                expectedPenalty.toString()
            );
        });

        it("rejects withdraw by non-owner", async () => {
            const attacker = Keypair.generate();

            await sleep(1000);

            const attackerAta = (await getOrCreateAssociatedTokenAccount(
                provider.connection, wallet.payer, stakeMint, attacker.publicKey
            )).address;

            await assertFails(
                program.methods
                    .withdrawPenalties()
                    .accountsPartial({
                        owner: attacker.publicKey,
                        pool,
                        stakeMint,
                        stakeVault,
                        ownerAta: attackerAta,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .signers([attacker])
                    .rpc(),
                "Unauthorized"
            );
        });

        it("owner can withdraw accumulated penalties", async () => {
            const poolBefore = await program.account.stakePool.fetch(pool);
            const penalties = BigInt(poolBefore.accumulatedPenalties.toString());
            assert.isTrue(penalties > 0n, "Need penalties to test withdrawal");

            const ownerBalBefore = await getTokenBalance(provider, userAtaStake);

            await program.methods
                .withdrawPenalties()
                .accountsPartial({
                    owner: wallet.publicKey,
                    pool,
                    stakeMint,
                    stakeVault,
                    ownerAta: userAtaStake,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const ownerBalAfter = await getTokenBalance(provider, userAtaStake);
            const poolAfter = await program.account.stakePool.fetch(pool);

            assert.equal(ownerBalAfter - ownerBalBefore, penalties);
            assert.equal(poolAfter.accumulatedPenalties.toString(), "0");
        });

        it("rejects second withdraw when no penalties remain", async () => {
            await assertFails(
                program.methods
                    .withdrawPenalties()
                    .accountsPartial({
                        owner: wallet.publicKey,
                        pool,
                        stakeMint,
                        stakeVault,
                        ownerAta: userAtaStake,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc(),
                "PenaltiesVaultEmpty"
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // F-03 🟠 High — Reward rate upper bound
    // ─────────────────────────────────────────────────────────────────────────
    describe("F-03 — reward rate upper bound", () => {
        it("rejects reward_rate above MAX_REWARD_RATE", async () => {
            const badSeed = randomSeed();
            const [badPool] = PublicKey.findProgramAddressSync(
                [Buffer.from("stakepool"), wallet.publicKey.toBuffer(), badSeed.toArrayLike(Buffer, "le", 8)],
                program.programId
            );

            await assertFails(
                program.methods
                    .initialize(badSeed, new BN(FEE_BPS), LOCK_DURATION, new BN(MAX_REWARD_RATE + 1))
                    .accountsPartial({
                        owner: wallet.publicKey,
                        pool: badPool,
                        stakeMint,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc(),
                "InvalidAmount"
            );
        });

        it("accepts reward_rate exactly at MAX_REWARD_RATE", async () => {
            const goodSeed = randomSeed();
            await setupPool(goodSeed, new BN(MAX_REWARD_RATE));
        });

        it("rejects u64::MAX reward_rate", async () => {
            const badSeed = randomSeed();
            const [badPool] = PublicKey.findProgramAddressSync(
                [Buffer.from("stakepool"), wallet.publicKey.toBuffer(), badSeed.toArrayLike(Buffer, "le", 8)],
                program.programId
            );

            const u64Max = new BN("18446744073709551615");

            await assertFails(
                program.methods
                    .initialize(badSeed, new BN(FEE_BPS), LOCK_DURATION, u64Max)
                    .accountsPartial({
                        owner: wallet.publicKey,
                        pool: badPool,
                        stakeMint,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc(),
                "InvalidAmount"
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // F-04 🟡 Medium — Pause / unpause circuit breaker
    // ─────────────────────────────────────────────────────────────────────────
    describe("F-04 — pause / unpause", () => {
        let pool: PublicKey;
        let rewardMint: PublicKey;
        let stakeVault: PublicKey;
        let userAtaReward: PublicKey;
        let stakeEntry: PublicKey;
        const seed = randomSeed();

        before(async () => {
            const result = await setupPool(seed);
            pool = result.pool;
            rewardMint = result.rewardMint;
            stakeVault = result.stakeVault;
            userAtaReward = await setupUserRewardAta(rewardMint);
            stakeEntry = await getStakeEntryAddress(pool);

            await stakeTokens(new BN(1_000_000), pool, stakeVault);
        });

        it("rejects pause by non-owner", async () => {
            const attacker = Keypair.generate();

            await sleep(1000);

            await assertFails(
                program.methods
                    .pausePool()
                    .accountsPartial({ owner: attacker.publicKey, pool })
                    .signers([attacker])
                    .rpc(),
                "Unauthorized"
            );
        });

        it("owner can pause pool", async () => {
            await program.methods
                .pausePool()
                .accountsPartial({ owner: wallet.publicKey, pool })
                .rpc();

            const poolState = await program.account.stakePool.fetch(pool);
            assert.isTrue(poolState.isPaused);
        });

        it("rejects double-pause", async () => {
            await assertFails(
                program.methods
                    .pausePool()
                    .accountsPartial({ owner: wallet.publicKey, pool })
                    .rpc(),
                "AlreadyPaused"
            );
        });

        it("stake is blocked while paused", async () => {
            await assertFails(
                program.methods
                    .addStake(new BN(100_000))
                    .accountsPartial({
                        owner: wallet.publicKey,
                        pool,
                        stakeMint,
                        stakeVault,
                        userAtaStake,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc(),
                "ProtocolPaused"
            );
        });

        it("unstake is blocked while paused", async () => {
            await assertFails(
                program.methods
                    .unstake(new BN(100_000))
                    .accountsPartial({
                        user: wallet.publicKey,
                        pool,
                        stakeMint,
                        stakeVault,
                        userAtaStake,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc(),
                "ProtocolPaused"
            );
        });

        it("claim_rewards is blocked while paused", async () => {
            await assertFails(
                program.methods
                    .claimRewards()
                    .accountsPartial({
                        user: wallet.publicKey,
                        pool,
                        rewardMint,
                        userAtaReward,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc(),
                "ProtocolPaused"
            );
        });

        it("rejects unpause by non-owner", async () => {
            const attacker = Keypair.generate();

            await sleep(1000);

            await assertFails(
                program.methods
                    .unpausePool()
                    .accountsPartial({ owner: attacker.publicKey, pool })
                    .signers([attacker])
                    .rpc(),
                "Unauthorized"
            );
        });

        it("owner can unpause pool", async () => {
            await program.methods
                .unpausePool()
                .accountsPartial({ owner: wallet.publicKey, pool })
                .rpc();

            const poolState = await program.account.stakePool.fetch(pool);
            assert.isFalse(poolState.isPaused);
        });

        it("rejects double-unpause", async () => {
            await assertFails(
                program.methods
                    .unpausePool()
                    .accountsPartial({ owner: wallet.publicKey, pool })
                    .rpc(),
                "NotPaused"
            );
        });

        it("stake works again after unpause", async () => {
            await stakeTokens(new BN(100_000), pool, stakeVault);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // F-05 🟡 Medium — Split stake instructions (Option A)
    // ─────────────────────────────────────────────────────────────────────────
    describe("F-05 — split stake instructions", () => {
        let pool: PublicKey;
        let stakeVault: PublicKey;
        const seed = randomSeed();

        before(async () => {
            const result = await setupPool(seed);
            pool = result.pool;
            stakeVault = result.stakeVault;
        });

        it("addStake fails when stake_entry does not exist yet", async () => {
            await assertFails(
                program.methods
                    .addStake(new BN(100_000))
                    .accountsPartial({
                        owner: wallet.publicKey,
                        pool,
                        stakeMint,
                        stakeVault,
                        userAtaStake,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc(),
                "AccountNotInitialized"
            );
        });

        it("initializeStake creates the entry on first call", async () => {
            await program.methods
                .initializeStake(new BN(100_000))
                .accountsPartial({
                    user: wallet.publicKey,
                    pool,
                    stakeMint,
                    stakeVault,
                    userAtaStake,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const stakeEntry = await getStakeEntryAddress(pool);
            const entry = await program.account.stakeEntry.fetch(stakeEntry);
            assert.equal(entry.owner.toBase58(), wallet.publicKey.toBase58());
        });

        it("initializeStake fails on second call — entry already exists", async () => {
            await assertFails(
                program.methods
                    .initializeStake(new BN(100_000))
                    .accountsPartial({
                        user: wallet.publicKey,
                        pool,
                        stakeMint,
                        stakeVault,
                        userAtaStake,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc(),
                "already in use"
            );
        });

        it("addStake succeeds once entry exists", async () => {
            const stakeEntry = await getStakeEntryAddress(pool);
            const before = await program.account.stakeEntry.fetch(stakeEntry);

            await program.methods
                .addStake(new BN(50_000))
                .accountsPartial({
                    owner: wallet.publicKey,
                    pool,
                    stakeMint,
                    stakeVault,
                    userAtaStake,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const after = await program.account.stakeEntry.fetch(stakeEntry);
            assert.equal(
                after.amountStaked.sub(before.amountStaked).toString(),
                "50000"
            );
        });

        it("addStake rejects a different user trying to add to another user's entry", async () => {
            const attacker = Keypair.generate();
            await sleep(1000);

            const attackerAta = (await getOrCreateAssociatedTokenAccount(
                provider.connection, wallet.payer, stakeMint, attacker.publicKey
            )).address;

            await mintTo(
                provider.connection, wallet.payer, stakeMint,
                attackerAta, wallet.payer, 100_000
            );

            const walletStakeEntry = await getStakeEntryAddress(pool, wallet.publicKey);

            await assertFails(
                program.methods
                    .addStake(new BN(50_000))
                    .accountsPartial({          // ← accounts() → accountsPartial()
                        owner: attacker.publicKey,
                        pool,
                        stakeMint,
                        stakeVault,
                        userAtaStake: attackerAta,
                        stakeEntry: walletStakeEntry,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .signers([attacker])
                    .rpc(),
                "Unauthorized"
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // F-06 🟡 Medium — close_stake_entry guards
    // ─────────────────────────────────────────────────────────────────────────
    describe("F-06 — close stake entry", () => {
        let pool: PublicKey;
        let rewardMint: PublicKey;
        let stakeVault: PublicKey;
        let stakeEntry: PublicKey;
        let userAtaReward: PublicKey;
        const seed = randomSeed();
        const stakeAmount = new BN(500_000);

        before(async () => {
            const result = await setupPool(seed);
            pool = result.pool;
            rewardMint = result.rewardMint;
            stakeVault = result.stakeVault;
            stakeEntry = await getStakeEntryAddress(pool);
            userAtaReward = await setupUserRewardAta(rewardMint);

            await stakeTokens(stakeAmount, pool, stakeVault);
        });

        it("rejects close while tokens are staked", async () => {
            await assertFails(
                program.methods
                    .closeStakeEntry()
                    .accountsPartial({ owner: wallet.publicKey, pool, stakeEntry })
                    .rpc(),
                "InsufficientStake"
            );
        });

        it("rejects close when rewards are pending", async () => {
            await sleep(32000);

            await program.methods
                .unstake(stakeAmount)
                .accountsPartial({
                    user: wallet.publicKey,
                    pool,
                    stakeMint,
                    stakeVault,
                    userAtaStake,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const entry = await program.account.stakeEntry.fetch(stakeEntry);
            if (entry.rewardsEarned.toNumber() > 0) {
                await assertFails(
                    program.methods
                        .closeStakeEntry()
                        .accountsPartial({ owner: wallet.publicKey, pool, stakeEntry })
                        .rpc(),
                    "NoRewards"
                );
            }
        });

        it("succeeds after full unstake and reward claim", async () => {
            const entry = await program.account.stakeEntry.fetch(stakeEntry);
            if (entry.rewardsEarned.toNumber() > 0) {
                await program.methods
                    .claimRewards()
                    .accountsPartial({
                        user: wallet.publicKey,
                        pool,
                        rewardMint,
                        userAtaReward,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc();
            }

            await program.methods
                .closeStakeEntry()
                .accountsPartial({ owner: wallet.publicKey, pool, stakeEntry })
                .rpc();

            const closed = await provider.connection.getAccountInfo(stakeEntry);
            assert.isNull(closed, "stake_entry should be closed and garbage collected");
        });

        it("rejects close by non-owner", async () => {
            const attacker = Keypair.generate();
            await provider.connection.requestAirdrop(attacker.publicKey, LAMPORTS_PER_SOL);
            await sleep(1000);

            const freshSeed = randomSeed();
            const { pool: freshPool, stakeVault: freshVault } = await setupPool(freshSeed);
            const freshEntry = await getStakeEntryAddress(freshPool);
            await stakeTokens(new BN(100_000), freshPool, freshVault);

            await assertFails(
                program.methods
                    .closeStakeEntry()
                    .accountsPartial({          // ← same fix
                        owner: attacker.publicKey,
                        pool: freshPool,
                        stakeEntry: freshEntry,
                    })
                    .signers([attacker])
                    .rpc(),
                "Unauthorized"
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // F-07 🟡 Medium — Penalty boundary conditions
    // ─────────────────────────────────────────────────────────────────────────
    describe("F-07 — penalty boundary conditions", () => {
        it("fee_bps = 9999 — applies near-total penalty without overflow", async () => {
            const seed = randomSeed();
            const { pool, stakeVault } = await setupPool(seed, REWARD_RATE, new BN(9_999));

            const stakeAmount = new BN(1_000_000);
            await stakeTokens(stakeAmount, pool, stakeVault);

            const userBalBefore = await getTokenBalance(provider, userAtaStake);
            const vaultBalBefore = await getTokenBalance(provider, stakeVault);

            await program.methods
                .unstake(stakeAmount)
                .accountsPartial({
                    user: wallet.publicKey,
                    pool,
                    stakeMint,
                    stakeVault,
                    userAtaStake,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const userBalAfter = await getTokenBalance(provider, userAtaStake);
            const vaultBalAfter = await getTokenBalance(provider, stakeVault);

            const penalty = BigInt(stakeAmount.toNumber()) * 9999n / 10_000n;
            const expectedOut = BigInt(stakeAmount.toNumber()) - penalty;

            assert.equal(userBalAfter - userBalBefore, expectedOut);
            assert.equal(vaultBalBefore - vaultBalAfter, BigInt(stakeAmount.toNumber()) - penalty);

            const poolState = await program.account.stakePool.fetch(pool);
            assert.equal(poolState.accumulatedPenalties.toString(), penalty.toString());
        });

        it("fee_bps = 0 — no penalty applied, full amount returned", async () => {
            const seed = randomSeed();
            const { pool, stakeVault } = await setupPool(seed, REWARD_RATE, new BN(0));

            const stakeAmount = new BN(500_000);
            await stakeTokens(stakeAmount, pool, stakeVault);

            const userBalBefore = await getTokenBalance(provider, userAtaStake);

            await program.methods
                .unstake(stakeAmount)
                .accountsPartial({
                    user: wallet.publicKey,
                    pool,
                    stakeMint,
                    stakeVault,
                    userAtaStake,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const userBalAfter = await getTokenBalance(provider, userAtaStake);

            assert.equal(userBalAfter - userBalBefore, BigInt(stakeAmount.toNumber()));

            const poolState = await program.account.stakePool.fetch(pool);
            assert.equal(poolState.accumulatedPenalties.toString(), "0");
        });

        it("penalty accounting is exact — vault delta equals amount_out", async () => {
            const seed = randomSeed();
            const feeBps = 750;
            const { pool, stakeVault } = await setupPool(seed, REWARD_RATE, new BN(feeBps));

            const stakeAmount = new BN(1_000_000);
            await stakeTokens(stakeAmount, pool, stakeVault);

            const vaultBefore = await getTokenBalance(provider, stakeVault);
            const userBefore = await getTokenBalance(provider, userAtaStake);

            await program.methods
                .unstake(stakeAmount)
                .accountsPartial({
                    user: wallet.publicKey,
                    pool,
                    stakeMint,
                    stakeVault,
                    userAtaStake,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();

            const vaultAfter = await getTokenBalance(provider, stakeVault);
            const userAfter = await getTokenBalance(provider, userAtaStake);

            const penalty = BigInt(stakeAmount.toNumber()) * BigInt(feeBps) / 10_000n;
            const amountOut = BigInt(stakeAmount.toNumber()) - penalty;

            assert.equal(vaultBefore - vaultAfter, amountOut);
            assert.equal(userAfter - userBefore, amountOut);
        });
    });
});