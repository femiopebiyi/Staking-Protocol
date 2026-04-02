use anchor_lang::prelude::*;

use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::helpers::update_rewards;
use crate::state::StakePool;
use crate::{errors::StakingError, state::StakeEntry};

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"stakepool", pool.owner.as_ref(), pool.seed.to_le_bytes().as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, StakePool>,

    pub stake_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = stake_mint,
        associated_token::authority = pool,
        associated_token::token_program = token_program,
    )]
    pub stake_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = stake_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_ata_stake: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + StakeEntry::INIT_SPACE,
        seeds = [b"stakeentry",  pool.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub stake_entry: Account<'info, StakeEntry>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> Stake<'info> {
    fn stake(&mut self, amount: u64, bumps: &StakeBumps, reward_rate: u64) -> Result<()> {
        require_gt!(amount, 0, StakingError::InvalidAmount);
        let clock = Clock::get()?;

        if self.stake_entry.owner == Pubkey::default() {
            self.stake_entry.amount_staked = 0;
            self.stake_entry.bump = bumps.stake_entry;
            self.stake_entry.owner = self.user.key();
            self.stake_entry.pool = self.pool.key();
            self.stake_entry.stake_start_time = clock.unix_timestamp;
            self.stake_entry.rewards_earned = 0;
            self.stake_entry.last_update_time = clock.unix_timestamp;
        } else {
            update_rewards(&mut self.stake_entry, clock.unix_timestamp, reward_rate)?;
        }

        transfer_checked(
            CpiContext::new(
                self.token_program.to_account_info(),
                TransferChecked {
                    authority: self.user.to_account_info(),
                    from: self.user_ata_stake.to_account_info(),
                    mint: self.stake_mint.to_account_info(),
                    to: self.stake_vault.to_account_info(),
                },
            ),
            amount,
            self.stake_mint.decimals,
        )?;

        self.stake_entry.amount_staked = self
            .stake_entry
            .amount_staked
            .checked_add(amount)
            .ok_or(StakingError::Overflow)?;

        self.pool.total_staked = self
            .pool
            .total_staked
            .checked_add(amount)
            .ok_or(StakingError::Overflow)?;

        Ok(())
    }
}

pub fn stake_handler(ctx: Context<Stake>, amount: u64) -> Result<()> {
    ctx.accounts
        .stake(amount, &ctx.bumps, ctx.accounts.pool.reward_rate)
}
