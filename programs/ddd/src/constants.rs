// pub const ESCROW_SEED:          &[u8] = b"escrow";
// pub const ESCROW_OFFER_SEED:    &[u8] = b"escrow_offer";
// pub const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";

use anchor_lang::prelude::*;
pub const ADMIN_PUBKEY: Pubkey = Pubkey::new_from_array([
    213, 87, 94, 214, 214, 165, 206, 242, 
    5, 5, 198, 8, 161, 238, 6, 189, 
    40, 25, 64, 163, 227, 222, 234, 236, 
    30, 140, 181, 100, 239, 26, 203, 217
]);

// Rate limiting constants
// pub const MIN_OFFER_AMOUNT: u64 = 10_000_000;     // 10 USDC minimum offer
// pub const MIN_FILL_AMOUNT: u64 = 1_000_000;       // 1 USDC minimum fill
pub const MAX_FILLS_PER_DAY: u16 = 70;            // Max fills per offer per day
pub const FILL_COOLDOWN_SECS: i64 = 2;            // 5 sec for tests; raise in production
pub const SECONDS_PER_DAY: i64 = 24 * 60 * 60;

// Universal: allow closing order when remaining is negligible (< 1 USDC)
pub const ORDER_CLOSE_DUST: u64 = 1_000_000; // 1 USDC in base units