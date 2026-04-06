use anchor_lang::prelude::*;

use crate::{errors::StakingError, state::StakePool};

#[derive(Accounts)]
pub struct PausePool<'info> {
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

impl<'info> PausePool<'info> {
    fn pause_pool(&mut self) -> Result<()> {
        require!(!self.pool.is_paused, StakingError::AlreadyPaused);
        self.pool.is_paused = true;

        Ok(())
    }
}

pub fn pause_pool_handler(ctx: Context<PausePool>) -> Result<()> {
    ctx.accounts.pause_pool()
}
