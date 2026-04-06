use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::errors::StakingError;
use crate::state::{StakeEntry, StakePool};

#[derive(Accounts)]
pub struct InitializeStake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

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
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_ata_stake: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,                                   // hard init — fails if exists
        payer = user,
        space = 8 + StakeEntry::INIT_SPACE,
        seeds = [b"stakeentry", pool.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub stake_entry: Account<'info, StakeEntry>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> InitializeStake<'info> {
    fn initialize_stake(&mut self, amount: u64, bumps: &InitializeStakeBumps) -> Result<()> {
        require!(!self.pool.is_paused, StakingError::ProtocolPaused);
        require_gt!(amount, 0, StakingError::InvalidAmount);

        let clock = Clock::get()?;

        // Initialize all fields — account is guaranteed fresh by `init`
        // No is_initialized flag needed; discriminator is the proof
        self.stake_entry.set_inner(StakeEntry {
            owner: self.user.key(),
            pool: self.pool.key(),
            amount_staked: 0, // updated after transfer below
            rewards_earned: 0,
            last_update_time: clock.unix_timestamp,
            stake_start_time: clock.unix_timestamp,
            bump: bumps.stake_entry, // canonical bump from Anchor
        });

        // Transfer tokens from user to vault
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

pub fn initialize_stake_handler(ctx: Context<InitializeStake>, amount: u64) -> Result<()> {
    ctx.accounts.initialize_stake(amount, &ctx.bumps)
}
