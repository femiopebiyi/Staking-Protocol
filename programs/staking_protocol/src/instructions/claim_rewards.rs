use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{mint_to, Mint, MintTo, TokenAccount, TokenInterface},
};

use crate::helpers::update_rewards;
use crate::state::StakePool;
use crate::{errors::StakingError, state::StakeEntry};

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"stakepool", pool.owner.as_ref(), pool.seed.to_le_bytes().as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, StakePool>,

    #[account(
        mut,
        seeds = [b"rp", pool.key().as_ref()],
        bump = pool.reward_mint_bump,
        mint::authority = pool,
        mint::token_program = token_program,
    )]
    pub reward_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [b"stakeentry", pool.key().as_ref(), user.key().as_ref()],
        bump = stake_entry.bump
    )]
    pub stake_entry: Account<'info, StakeEntry>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = reward_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_ata_reward: Box<InterfaceAccount<'info, TokenAccount>>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> ClaimRewards<'info> {
    fn claim_rewards(&mut self) -> Result<()> {
        require!(!self.pool.is_paused, StakingError::ProtocolPaused);
        // 1. Settle pending rewards up to now
        let clock = Clock::get()?;
        update_rewards(
            &mut self.stake_entry,
            clock.unix_timestamp,
            self.pool.reward_rate,
        )?;

        // 2. Snapshot and validate
        let rewards = self.stake_entry.rewards_earned;
        require!(rewards > 0, StakingError::NoRewards);

        // 3. Zero out BEFORE minting
        self.stake_entry.rewards_earned = 0;

        // 4. Pool PDA signs to mint rewards
        let seeds = &[
            b"stakepool",
            self.pool.owner.as_ref(),
            &self.pool.seed.to_le_bytes(),
            &[self.pool.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        mint_to(
            CpiContext::new_with_signer(
                self.token_program.to_account_info(),
                MintTo {
                    mint: self.reward_mint.to_account_info(),
                    to: self.user_ata_reward.to_account_info(),
                    authority: self.pool.to_account_info(),
                },
                signer_seeds,
            ),
            rewards,
        )?;

        Ok(())
    }
}

pub fn claim_rewards_handler(ctx: Context<ClaimRewards>) -> Result<()> {
    ctx.accounts.claim_rewards()
}
