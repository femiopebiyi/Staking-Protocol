use anchor_lang::prelude::*;

use crate::{
    errors::StakingError,
    state::{StakeEntry, StakePool},
};

#[derive(Accounts)]
pub struct CloseStakeEntry<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [b"stakepool", pool.owner.as_ref(), pool.seed.to_le_bytes().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, StakePool>,

    #[account(
        mut,
        close = owner,
        seeds = [b"stakeentry", pool.key().as_ref(), owner.key().as_ref()],
        bump = stake_entry.bump,
        has_one = owner @ StakingError::Unauthorized,
    )]
    pub stake_entry: Account<'info, StakeEntry>,
}

pub fn close_stake_entry_handler(ctx: Context<CloseStakeEntry>) -> Result<()> {
    let entry = &ctx.accounts.stake_entry;

    // Guard: don't let users close and escape with unclaimed rewards or balance
    require!(entry.amount_staked == 0, StakingError::InsufficientStake);
    require!(entry.rewards_earned == 0, StakingError::NoRewards);

    ctx.accounts.stake_entry.is_initialized = false;

    Ok(())
}
