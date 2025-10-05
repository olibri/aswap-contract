use anchor_lang::prelude::*;

#[error_code]
pub enum UniversalOrderError {
    #[msg("Insufficient token balance")]
    InsufficientBalance,
    
    #[msg("Invalid order type")]
    InvalidOrderType,
    
    #[msg("Order not found")]
    OrderNotFound,
    
    #[msg("Unauthorized action")]
    Unauthorized,
    
    #[msg("Invalid order status for this operation")]
    InvalidOrderStatus,
    
    #[msg("Race condition detected - operation already performed")]
    RaceCondition,
    
    #[msg("Order already completed")]
    OrderCompleted,
    
    #[msg("Order already cancelled")]
    OrderCancelled,
    
    #[msg("Cannot cancel order at this stage")]
    CannotCancel,
    
    #[msg("Both parties must sign before settlement")]
    SignatureRequired,
    
    #[msg("Invalid amount - exceeds available")]
    InvalidAmount,
    
    #[msg("Fiat Guy cannot lock crypto - role violation")]
    FiatGuyCannotLockCrypto,
    
    #[msg("Crypto Guy must lock crypto first")]
    CryptoGuyMustLockFirst,
    
    #[msg("Invalid token account - mint mismatch")]
    InvalidTokenAccount,
    
    #[msg("Token account required for this operation")]
    TokenAccountRequired,
}