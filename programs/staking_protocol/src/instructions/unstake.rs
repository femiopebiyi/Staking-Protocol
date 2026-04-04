use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::helpers::update_rewards;
use crate::state::StakePool;
use crate::{errors::StakingError, state::StakeEntry};

#[derive(Accounts)]
pub struct Unstake<'info> {
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
        mut,
        seeds = [b"stakeentry", pool.key().as_ref(), user.key().as_ref()],
        bump = stake_entry.bump
    )]
    pub stake_entry: Account<'info, StakeEntry>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> Unstake<'info> {
    fn unstake(&mut self, amount: u64) -> Result<()> {
        // 1. Validate inputs
        require!(amount > 0, StakingError::InvalidAmount);
        require!(
            amount <= self.stake_entry.amount_staked,
            StakingError::InsufficientStake
        );

        let clock = Clock::get()?;

        // 2. Calculate penalty before settling rewards
        // No hard reject — fee_bps penalty applies if still locked, 0 if unlocked
        let penalty =
            if clock.unix_timestamp < self.stake_entry.stake_start_time + self.pool.lock_duration {
                (amount as u128)
                    .checked_mul(self.pool.fee_bps as u128)
                    .ok_or(StakingError::Overflow)?
                    .checked_div(10_000)
                    .ok_or(StakingError::Overflow)? as u64
            } else {
                0
            };

        // 3. Settle pending rewards after all validation passes
        update_rewards(
            &mut self.stake_entry,
            clock.unix_timestamp,
            self.pool.reward_rate,
        )?;

        let amount_out = amount.checked_sub(penalty).ok_or(StakingError::Overflow)?;

        // 4. Build PDA signer seeds
        let seeds = &[
            b"stakepool",
            self.pool.owner.as_ref(),
            &self.pool.seed.to_le_bytes(),
            &[self.pool.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // 5. Transfer tokens from vault to user — pool PDA signs
        transfer_checked(
            CpiContext::new_with_signer(
                self.token_program.to_account_info(),
                TransferChecked {
                    from: self.stake_vault.to_account_info(),
                    to: self.user_ata_stake.to_account_info(),
                    mint: self.stake_mint.to_account_info(),
                    authority: self.pool.to_account_info(),
                },
                signer_seeds,
            ),
            amount_out,
            self.stake_mint.decimals,
        )?;

        // 6. Decrement by full requested amount — penalty stays in vault
        self.stake_entry.amount_staked = self
            .stake_entry
            .amount_staked
            .checked_sub(amount)
            .ok_or(StakingError::Overflow)?;

        // 7. Reset stake_start_time if fully unstaked
        if self.stake_entry.amount_staked == 0 {
            self.stake_entry.stake_start_time = 0;
        }

        // 8. Decrement pool total by full requested amount
        self.pool.total_staked = self
            .pool
            .total_staked
            .checked_sub(amount)
            .ok_or(StakingError::Overflow)?;

        self.pool.accumulated_penalties = self
            .pool
            .accumulated_penalties
            .checked_add(penalty)
            .ok_or(StakingError::Overflow)?;

        Ok(())
    }
}

pub fn unstake_handler(ctx: Context<Unstake>, amount: u64) -> Result<()> {
    ctx.accounts.unstake(amount)
}
