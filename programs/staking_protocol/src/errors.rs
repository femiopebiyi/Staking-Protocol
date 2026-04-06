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
    #[msg("Cannot close account with active stake")]
    ActiveStake,
    #[msg("Cannot close account with unclaimed rewards")]
    UnclaimedRewards,
    #[msg("There is not penalties accumulated")]
    PenaltiesVaultEmpty,
    #[msg("There is not enough funds in the vault")]
    InsufficientFunds,
    #[msg("Pool is already paused")]
    AlreadyPaused,
    #[msg("Pool is not paused")]
    NotPaused,
    #[msg("Pool is paused")]
    ProtocolPaused,
    #[msg("Stake entry already exists — use add_stake instead")]
    StakeEntryAlreadyExists,
    #[msg("Stake entry does not exist — use initialize_stake first")]
    StakeEntryNotFound,
    #[msg("Pool is invalid")]
    InvalidPool,
}
