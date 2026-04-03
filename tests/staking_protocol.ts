import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { StakingProtocol } from "../target/types/staking_protocol";
import { PublicKey } from "@solana/web3.js";
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
            100_000_000
        );
    });

    // ── Shared helpers ────────────────────────────────────────────────────────

    async function setupPool(seed: BN) {
        const [pool] = PublicKey.findProgramAddressSync(
            [Buffer.from("stakepool"), wallet.publicKey.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
            program.programId
        );
        const [rewardMint] = PublicKey.findProgramAddressSync(
            [Buffer.from("rp"), pool.toBuffer()],
            program.programId
        );

        // seed is first — matches handler signature order
        // vaults are NOT pre-created — initialize uses init for both
        await program.methods
            .initialize(seed, new BN(FEE_BPS), LOCK_DURATION, REWARD_RATE)
            .accountsPartial({
                owner: wallet.publicKey,
                pool,
                stakeMint,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();

        // derive vault addresses after init creates them
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

    async function stakeTokens(amount: BN, pool: PublicKey, stakeVault: PublicKey) {
        await program.methods
            .stake(amount)
            .accountsPartial({
                user: wallet.publicKey,
                pool,
                stakeMint,
                stakeVault,
                userAtaStake,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();
    }

    async function getStakeEntryAddress(pool: PublicKey): Promise<PublicKey> {
        const [stakeEntry] = PublicKey.findProgramAddressSync(
            [Buffer.from("stakeentry"), pool.toBuffer(), wallet.publicKey.toBuffer()],
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

        it("first stake initializes entry correctly", async () => {
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

        it("subsequent stake accumulates amount correctly", async () => {
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

        it("rejects zero amount", async () => {
            await assertFails(
                program.methods
                    .stake(new BN(0))
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
});