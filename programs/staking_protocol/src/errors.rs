use anchor_lang::prelude::*;

#[error_code]
pub enum StakingError {
    #[msg("Tokens are still locked")]
    StillLocked,
    #[msg("Invalid amount — must be greater than zero")]
    InvalidAmount,
    #[msg("Insufficient staked balance")]
    InsufficientStake,
    #[msg("No rewards to claim")]
    NoRewards,
    #[msg("Reward vault is empty")]
    RewardVaultEmpty,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Invalid Fee")]
    InvalidFee,
    #[msg("Mint does not match pool configuration")]
    InvalidMint,
    #[msg("Pass in a valid lock duration")]
    InvalidLockDuration,
    #[msg("Unauthorized signature")]
    Unauthorized,
}
