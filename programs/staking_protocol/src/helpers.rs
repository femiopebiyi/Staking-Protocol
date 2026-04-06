use crate::{errors::StakingError, state::StakeEntry};
use anchor_lang::prelude::*;
const SCALE: u128 = 1_000_000_000;

// called before every stake/unstake/claim to settle pending rewards
pub fn update_rewards(
    stake_entry: &mut StakeEntry,
    current_time: i64,
    reward_rate: u64,
) -> Result<()> {
    let time_elapsed = current_time.saturating_sub(stake_entry.last_update_time) as u64;

    let new_rewards_u128 = (stake_entry.amount_staked as u128)
        .checked_mul(reward_rate as u128)
        .ok_or(StakingError::Overflow)?
        .checked_mul(time_elapsed as u128)
        .ok_or(StakingError::Overflow)?
        .checked_div(SCALE)
        .ok_or(StakingError::Overflow)?;

    let new_rewards = u64::try_from(new_rewards_u128).map_err(|_| StakingError::Overflow)?;

    stake_entry.rewards_earned = stake_entry
        .rewards_earned
        .checked_add(new_rewards)
        .ok_or(StakingError::Overflow)?;

    stake_entry.last_update_time = current_time;
    Ok(())
}
