use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct StakeEntry {
    pub is_initialized: bool,
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub amount_staked: u64,
    pub rewards_earned: u64,   // accumulated but unclaimed rewards
    pub last_update_time: i64, // unix timestamp of last interaction
    pub stake_start_time: i64, // when they first staked (for lock period)
    pub bump: u8,
}
