use anchor_lang::prelude::*;

use crate::{errors::StakingError, state::StakePool};

#[derive(Accounts)]
pub struct UnpausePool<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"stakepool", pool.owner.as_ref(), pool.seed.to_le_bytes().as_ref()],
        bump = pool.bump,
        has_one = owner @StakingError::Unauthorized
    )]
    pub pool: Account<'info, StakePool>,
}

impl<'info> UnpausePool<'info> {
    fn unpause_pool(&mut self) -> Result<()> {
        require!(self.pool.is_paused, StakingError::NotPaused);
        self.pool.is_paused = false;

        Ok(())
    }
}

pub fn unpause_pool_handler(ctx: Context<UnpausePool>) -> Result<()> {
    ctx.accounts.unpause_pool()
}
