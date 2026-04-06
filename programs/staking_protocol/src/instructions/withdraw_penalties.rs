use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::StakingError;
use crate::state::StakePool;

#[derive(Accounts)]
pub struct WithdrawPenalties<'info> {
    #[account(
        mut
    )]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"stakepool", pool.owner.as_ref(), pool.seed.to_le_bytes().as_ref()],
        bump = pool.bump,
        has_one = owner @StakingError::Unauthorized
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
    pub stake_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = owner, 
        associated_token::mint = stake_mint, 
        associated_token::authority = owner,
        associated_token::token_program = token_program,
    )]
    pub owner_ata: InterfaceAccount<'info, TokenAccount>,

    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

impl<'info> WithdrawPenalties<'info> {
    fn withdraw_penalties(&mut self) -> Result<()> {
         let penalties = self.pool.accumulated_penalties;

    require!(penalties > 0, StakingError::PenaltiesVaultEmpty);

    // Sanity: vault must actually hold what we're about to transfer
    require!(
        self.stake_vault.amount >= penalties,
        StakingError::InsufficientFunds   // or a new VaultUnderflow variant
    );

        let seeds = &[
            b"stakepool",
            self.pool.owner.as_ref(),
            &self.pool.seed.to_le_bytes(),
            &[self.pool.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        transfer_checked(
            CpiContext::new_with_signer(
                self.token_program.to_account_info(),
                TransferChecked {
                    authority: self.pool.to_account_info(),
                    from: self.stake_vault.to_account_info(),
                    to: self.owner_ata.to_account_info(),
                    mint: self.stake_mint.to_account_info(),
                },
                signer_seeds,
            ),
            self.pool.accumulated_penalties,
            self.stake_mint.decimals,
        )?;

        self.pool.accumulated_penalties = 0;

        Ok(())
    }
}

pub fn withdraw_penalties_handler(ctx: Context<WithdrawPenalties>) -> Result<()>{
    ctx.accounts.withdraw_penalties()
}