use anchor_lang::prelude::*;
mod state;
use state::*;

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
        fee_bps: u64,
        seed: u64,
        lock_duration: i64,
        reward_rate: u64,
    ) -> Result<()> {
        instructions::initialize::initialize_handler(ctx, fee_bps, seed, lock_duration, reward_rate)
    }

    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        instructions::stake::stake_handler(ctx, amount)
    }

    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        instructions::unstake::unstake_handler(ctx, amount)
    }
}
