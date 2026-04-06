use anchor_lang::prelude::*;

use crate::{
    errors::StakingError,
    helpers::update_rewards,
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
    let clock = Clock::get()?;
    // Settle any pending rewards before final checks
    update_rewards(
        &mut ctx.accounts.stake_entry,
        clock.unix_timestamp,
        ctx.accounts.pool.reward_rate,
    )?;

    require!(
        ctx.accounts.stake_entry.amount_staked == 0,
        StakingError::InsufficientStake
    );
    require!(
        ctx.accounts.stake_entry.rewards_earned == 0,
        StakingError::NoRewards
    );

    Ok(())
}
