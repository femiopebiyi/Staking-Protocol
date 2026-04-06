use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::errors::StakingError;
use crate::helpers::update_rewards;
use crate::state::{StakeEntry, StakePool};

#[derive(Accounts)]
pub struct AddStake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"stakepool", pool.owner.as_ref(), pool.seed.to_le_bytes().as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, StakePool>,

    #[account(
        address = pool.stake_mint @ StakingError::InvalidMint
    )]
    pub stake_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = stake_mint,
        associated_token::authority = pool,
        associated_token::token_program = token_program,
    )]
    pub stake_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = stake_mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program,
    )]
    pub user_ata_stake: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"stakeentry", pool.key().as_ref(), owner.key().as_ref()],
        bump = stake_entry.bump,
        has_one = owner @ StakingError::Unauthorized,  // enforces stake_entry.owner == user
        constraint = stake_entry.pool == pool.key() @ StakingError::InvalidPool,
    )]
    pub stake_entry: Account<'info, StakeEntry>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> AddStake<'info> {
    fn add_stake(&mut self, amount: u64) -> Result<()> {
        require!(!self.pool.is_paused, StakingError::ProtocolPaused);
        require_gt!(amount, 0, StakingError::InvalidAmount);

        let clock = Clock::get()?;

        // Settle pending rewards before touching amount_staked
        update_rewards(
            &mut self.stake_entry,
            clock.unix_timestamp,
            self.pool.reward_rate,
        )?;

        // Reset lock timer only if re-entering from a fully empty position
        if self.stake_entry.amount_staked == 0 {
            self.stake_entry.stake_start_time = clock.unix_timestamp;
        }

        // Transfer tokens from user to vault
        transfer_checked(
            CpiContext::new(
                self.token_program.to_account_info(),
                TransferChecked {
                    authority: self.owner.to_account_info(),
                    from: self.user_ata_stake.to_account_info(),
                    mint: self.stake_mint.to_account_info(),
                    to: self.stake_vault.to_account_info(),
                },
            ),
            amount,
            self.stake_mint.decimals,
        )?;

        // Update balances after successful transfer
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

pub fn add_stake_handler(ctx: Context<AddStake>, amount: u64) -> Result<()> {
    ctx.accounts.add_stake(amount)
}
