use anchor_lang::prelude::*;
#[account]
#[derive(InitSpace)]
pub struct StakePool {
    pub seed: u64,
    pub fee_bps: u64,
    pub accumulated_penalties: u64,
    pub owner: Pubkey,
    pub stake_mint: Pubkey,  // token users stake
    pub reward_mint: Pubkey, // token users earn
    pub stake_vault: Pubkey,
    pub reward_rate: u64,   // rewards per token per second (scaled)
    pub lock_duration: i64, // seconds user must wait before unstaking
    pub total_staked: u64,  // total tokens currently staked
    pub bump: u8,
    pub reward_mint_bump: u8,
    pub is_paused: bool,
}
