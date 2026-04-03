# Solana Staking Protocol

A staking program built on Solana using the Anchor framework. Users deposit tokens into a pool, earn rewards over time, and can withdraw at any point — with an early withdrawal penalty applied if they exit before the lock period ends.

---

## How It Works

The program has four instructions:

**Initialize** — the pool owner creates a staking pool, sets the reward rate, lock duration, and early withdrawal fee. A reward mint is created as a program-derived address (PDA), meaning the program controls all reward token minting. A stake vault and reward vault are also created during initialization.

**Stake** — users deposit stake tokens into the pool vault. A stake entry account is created on their first deposit to track their balance, accumulated rewards, and timestamps. Subsequent stakes update the entry and settle any pending rewards before adding to the balance.

**Unstake** — users withdraw their staked tokens. If they withdraw before the lock period expires, a fee is deducted from the amount they receive and the penalty stays in the vault, benefiting remaining stakers. After the lock period, the full amount is returned.

**Claim Rewards** — users collect accumulated reward tokens without touching their staked balance. Rewards are minted fresh by the program (the pool PDA is the mint authority). After claiming, the rewards counter resets to zero and accumulation starts again from the current time.

---

## Reward Calculation

Rewards accumulate based on three factors — amount staked, reward rate, and time elapsed:

```
rewards = amount_staked * reward_rate * time_elapsed / SCALE
```

`SCALE` is `1_000_000_000` to preserve precision in integer arithmetic. The reward rate is set at pool initialization and applies uniformly to all stakers.

Rewards are calculated lazily — the program does not continuously update every staker. Instead, pending rewards are settled whenever a user interacts with the program (stake, unstake, or claim). The `last_update_time` timestamp is updated on every interaction to mark when rewards were last settled.

---

## Early Withdrawal

The pool has a configurable `fee_bps` (basis points) and `lock_duration` (seconds). If a user unstakes before `stake_start_time + lock_duration`:

```
penalty    = amount * fee_bps / 10_000
amount_out = amount - penalty
```

The penalty stays in the stake vault and is not redistributed — it effectively increases the vault balance relative to outstanding LP claims, benefiting stakers who stay.

---

## Reward Token Design

This protocol uses a mint-on-demand approach. The reward mint is a PDA created by the program, and new reward tokens are minted directly to claimants rather than transferred from a pre-funded vault. This means:

- Rewards never run dry
- The reward token supply is unbounded and grows with usage
- The pool owner does not need to fund reward emissions

An alternative approach used by some protocols is a pre-funded vault with a fixed reward budget. That model gives the token a controlled supply but requires the owner to actively top up the vault. Both approaches have valid use cases depending on the token's purpose.

---

## Program Accounts

**StakePool** — global pool config stored in a PDA derived from `[b"stakepool", owner, seed]`. Holds the reward rate, lock duration, fee, total staked amount, and references to all associated accounts.

**StakeEntry** — per-user account stored in a PDA derived from `[b"stakeentry", pool, user]`. Tracks the user's staked amount, accumulated rewards, and timestamps.

**Stake Vault** — associated token account (ATA) holding deposited stake tokens, owned by the pool PDA.

**Reward Vault** — ATA holding reward tokens, owned by the pool PDA. Not used for payouts in this design (rewards are minted directly) but created at initialization for potential future use.

**Reward Mint** — SPL mint PDA derived from `[b"rp", pool]`. The pool PDA is the mint authority, allowing the program to mint rewards on-demand.

---

## Project Structure

```
programs/staking_protocol/src/
├── lib.rs
├── instructions/
│   ├── mod.rs
│   ├── initialize.rs
│   ├── stake.rs
│   ├── unstake.rs
│   └── claim_rewards.rs
├── state/
│   ├── mod.rs
│   ├── stake_pool.rs
│   └── stake_entry.rs
├── helpers.rs
└── errors.rs

tests/
└── staking_protocol.ts
```

---

## Prerequisites

- Rust
- Solana CLI
- Anchor CLI
- Node.js 20+
- Yarn

---

## Setup

Clone the repository and install dependencies:

```bash
git clone <repo-url>
cd staking_protocol
yarn install
```

---

## Building and Deploying

```bash
anchor build
anchor deploy
```

The program is configured to deploy to Devnet. Update `Anchor.toml` to change the target cluster.

---

## Running Tests

The test suite is organized by instruction and each suite runs independently with its own pool:

```bash
# full suite
anchor run test

# individual suites
anchor run test-init
anchor run test-stake
anchor run test-unstake
anchor run test-claim
```

Tests use real devnet time for reward accumulation, so some tests include short sleep intervals. The lock duration is set to 2 seconds in tests to keep wait times manageable.

---

## Configuration

When initializing a pool the owner sets:

| Parameter | Description |
|---|---|
| `seed` | Unique u64 used to derive the pool PDA — allows multiple pools per owner |
| `fee_bps` | Early withdrawal penalty in basis points (e.g. 500 = 5%). Must be less than 10000 |
| `lock_duration` | Seconds before a user can unstake without penalty |
| `reward_rate` | Reward tokens earned per staked token per second, scaled by 1_000_000_000 |

---

## Security Considerations

**Reward rate is pool-controlled.** The reward rate is stored in the pool at initialization and read from there during staking — users cannot pass their own rate.

**Reward mint is PDA-derived.** The reward mint address is derived from the pool PDA with seeds, making it impossible to substitute a foreign mint in claim transactions.

**Rewards settled before balance changes.** Every stake and unstake call settles pending rewards before modifying `amount_staked`. This prevents reward calculation from using an incorrect balance.

**Overflow protection.** All arithmetic uses checked operations and returns a clean error on overflow rather than panicking.

**Time underflow protection.** `last_update_time` subtraction uses `saturating_sub` to prevent panics if the clock is ever inconsistent.
