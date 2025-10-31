use anchor_lang::prelude::*;

/// Universal Order State
/// Works for both Sell Orders (CryptoGuy creates) and Buy Orders (FiatGuy creates)
/// Single PDA pattern: [b"universal_order", creator.key(), mint.key(), order_id]
#[account]
pub struct UniversalOrder {
    /// Order creator (can be CryptoGuy or FiatGuy)
    pub creator: Pubkey,
    
    /// The other party who accepts/fills the order
    pub acceptor: Option<Pubkey>,
    
    /// Mint of the cryptocurrency being traded
    pub crypto_mint: Pubkey,
    
    /// Order type: true = SellOrder (CryptoGuy→FiatGuy), false = BuyOrder (FiatGuy→CryptoGuy)
    pub is_sell_order: bool,
    
    /// Amount of cryptocurrency tokens
    pub crypto_amount: u64,
    
    /// Fiat amount (for reference only, actual payment is off-chain)
    pub fiat_amount: u64,
    
    /// Unique order ID (timestamp or counter)
    pub order_id: u64,
    
    /// Partial fill support: total amount filled and settled
    pub filled_amount: u64,

    /// Sum reserved by active tickets (parallel partial fills)
    pub reserved_amount: u64,

    /// Rate limiting: last action timestamp (for cooldown)
    pub last_action_ts: i64,
    /// Rate limiting: counter of fills in current day window
    pub daily_fill_count: u16,
    /// Rate limiting: last daily reset timestamp
    pub daily_reset_ts: i64,
    
    /// Creation timestamp
    pub created_at: i64,
    
    /// Last update timestamp  
    pub updated_at: i64,
    
    /// Vault holding the locked crypto tokens
    pub vault: Pubkey,
    
    /// Bump for PDA derivation
    pub bump: u8,
}

impl UniversalOrder {
    /// Calculate space needed for the account
    pub const SPACE: usize = 8 + // discriminator
        32 + // creator
        (1 + 32) + // acceptor (Option<Pubkey>)
        32 + // crypto_mint
        1 + // is_sell_order
        8 + // crypto_amount
        8 + // fiat_amount
        8 + // order_id
        8 + // filled_amount
        8 + // reserved_amount
        8 + // last_action_ts
        2 + // daily_fill_count
        8 + // daily_reset_ts
        8 + // created_at
        8 + // updated_at
        32 + // vault
        1; // bump


    
    /// Get remaining amount that can be filled
    pub fn remaining_amount(&self) -> u64 {
        self.crypto_amount.saturating_sub(self.filled_amount)
    }

    /// Amount still available to reserve by new tickets
    pub fn available_amount(&self) -> u64 {
        self.remaining_amount().saturating_sub(self.reserved_amount)
    }
}

/// FillTicket - individual parallel partial fill intent
#[account]
pub struct FillTicket {
    /// Parent order
    pub order: Pubkey,
    /// The opposite party who accepted this ticket
    pub acceptor: Pubkey,
    /// Amount reserved for this ticket
    pub amount: u64,
    /// Role-based signatures per ticket
    pub crypto_guy_signed: bool,
    pub fiat_guy_signed: bool,
    /// Optional client-side identifier to avoid collisions
    pub ticket_id: u64,
    /// Creation timestamp
    pub created_at: i64,
    /// Bump for PDA
    pub bump: u8,
}

impl FillTicket {
    pub const SPACE: usize = 8 + // discriminator
        32 + // order
        32 + // acceptor
        8 +  // amount
        1 +  // crypto_guy_signed
        1 +  // fiat_guy_signed
        8 +  // ticket_id
        8 +  // created_at
        1;   // bump
}