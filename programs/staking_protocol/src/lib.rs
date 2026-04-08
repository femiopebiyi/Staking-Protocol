use anchor_lang::prelude::*;
mod state;

mod instructions;
use instructions::*;

mod errors;

mod helpers;

declare_id!("83SYHSQguraGomFDQizSGt7pp7oRJy3zdAdEmhXrR3H5");

#[program]
pub mod staking_protocol {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        seed: u64,
        fee_bps: u64,
        lock_duration: i64,
        reward_rate: u64,
    ) -> Result<()> {
        instructions::initialize::initialize_handler(ctx, seed, fee_bps, lock_duration, reward_rate)
    }

    pub fn initialize_stake(ctx: Context<InitializeStake>, amount: u64) -> Result<()> {
        instructions::initialize_stake::initialize_stake_handler(ctx, amount)
    }

    pub fn add_stake(ctx: Context<AddStake>, amount: u64) -> Result<()> {
        instructions::add_stake::add_stake_handler(ctx, amount)
    }

    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        instructions::unstake::unstake_handler(ctx, amount)
    }

    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        instructions::claim_rewards::claim_rewards_handler(ctx)
    }

    pub fn close_stake_entry(ctx: Context<CloseStakeEntry>) -> Result<()> {
        instructions::close_stake_entry::close_stake_entry_handler(ctx)
    }

    pub fn withdraw_penalties(ctx: Context<WithdrawPenalties>) -> Result<()> {
        instructions::withdraw_penalties::withdraw_penalties_handler(ctx)
    }

    pub fn pause_pool(ctx: Context<PausePool>) -> Result<()> {
        instructions::pause_pool::pause_pool_handler(ctx)
    }
    pub fn unpause_pool(ctx: Context<UnpausePool>) -> Result<()> {
        instructions::unpause_pool::unpause_pool_handler(ctx)
    }
}
