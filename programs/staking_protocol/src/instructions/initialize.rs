use anchor_lang::prelude::*;

use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::errors::StakingError;
use crate::state::StakePool;

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + StakePool::INIT_SPACE,
        seeds = [b"stakepool", owner.key().as_ref(), seed.to_le_bytes().as_ref()],
        bump
    )]
    pub pool: Account<'info, StakePool>,

    #[account(
        init,
        payer = owner,
        seeds = [b"rp", pool.key().as_ref()],
        bump,
        mint::decimals = 6,
        mint::authority = pool,
        mint::token_program = token_program,
    )]
    pub reward_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mint::token_program = token_program,
    )]
    pub stake_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = owner,
        associated_token::mint = stake_mint,
        associated_token::authority = pool,
        associated_token::token_program = token_program
    )]
    pub stake_vault: InterfaceAccount<'info, TokenAccount>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> Initialize<'info> {
    fn initialize(
        &mut self,
        fee_bps: u64,
        seed: u64,
        bumps: &InitializeBumps,
        lock_duration: i64,
        reward_rate: u64,
    ) -> Result<()> {
        require!(fee_bps < 10_000, StakingError::InvalidFee);
        require!(lock_duration >= 0, StakingError::InvalidLockDuration);
        const MAX_REWARD_RATE: u64 = 1_000_000_000; // tune per token economics
        require!(reward_rate > 0, StakingError::InvalidAmount);
        require!(reward_rate <= MAX_REWARD_RATE, StakingError::InvalidAmount);

        self.pool.set_inner(StakePool {
            seed,
            bump: bumps.pool,
            lock_duration,
            owner: self.owner.key(),
            reward_mint: self.reward_mint.key(),
            reward_rate,
            stake_mint: self.stake_mint.key(),
            stake_vault: self.stake_vault.key(),
            reward_mint_bump: bumps.reward_mint,
            total_staked: 0,
            fee_bps,
            accumulated_penalties: 0,
            is_paused: false,
        });

        Ok(())
    }
}

pub fn initialize_handler(
    ctx: Context<Initialize>,
    seed: u64,
    fee_bps: u64,

    lock_duration: i64,
    reward_rate: u64,
) -> Result<()> {
    ctx.accounts
        .initialize(fee_bps, seed, &ctx.bumps, lock_duration, reward_rate)
}
