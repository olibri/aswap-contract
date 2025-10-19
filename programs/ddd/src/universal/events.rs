use anchor_lang::prelude::*;

/// Universal Order Events for blockchain parsing

/// Emitted when an offer is accepted and crypto is locked (replaces UniversalOrderCreated + TicketAccepted)
#[event]
pub struct OfferAccepted {
    // Order info
    pub order: Pubkey,
    pub order_id: u64,
    pub creator: Pubkey,         // Who created the offer in DB
    pub crypto_mint: Pubkey,
    pub vault: Pubkey,
    pub is_sell_order: bool,
    pub crypto_amount: u64,
    pub fiat_amount: u64,
    
    // Ticket info
    pub ticket: Pubkey,
    pub ticket_id: u64,          // Always 1 (first ticket)
    pub locked_amount: u64,      // How much was locked
    
    // Parties
    pub crypto_guy: Pubkey,      // Who locks tokens
    pub fiat_guy: Pubkey,        // Who pays fiat
    
    pub timestamp: i64,
}

#[event]
pub struct TicketSigned {
    pub order: Pubkey,
    pub ticket: Pubkey,
    pub signer: Pubkey,
    pub is_crypto_guy: bool,
    pub is_fiat_guy: bool,
    pub both_signed: bool,
    pub timestamp: i64,
}

#[event]
pub struct TicketSettled {
    pub order: Pubkey,
    pub ticket: Pubkey,
    pub amount: u64,          // Total amount (100%)
    pub fee_amount: u64,      // Fee amount (0.2%)
    pub net_amount: u64,      // Net to fiat_guy (99.8%)
    pub fiat_guy: Pubkey,
    pub crypto_guy: Pubkey,
    pub total_filled: u64,
    pub timestamp: i64,
}

#[event]
pub struct TicketCancelled {
    pub order: Pubkey,
    pub ticket: Pubkey,
    pub canceller: Pubkey,
    pub amount: u64,
    pub refunded: bool, // true if Buy order refund happened
    pub timestamp: i64,
}

#[event]
pub struct OrderCancelled {
    pub order: Pubkey,
    pub creator: Pubkey,
    pub amount_returned: u64,
    pub is_sell_order: bool,
    pub remaining_after: u64,
    pub timestamp: i64,
}

#[event]
pub struct OrderClosed {
    pub order: Pubkey,
    pub creator: Pubkey,
    pub dust_amount: u64,
    pub rent_returned_to: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct UniversalAdminResolved {
    pub order: Pubkey,
    pub ticket: Option<Pubkey>, // None for order-level, Some for ticket-level
    pub admin: Pubkey,
    pub amount: u64,
    pub recipient: Pubkey,
    pub resolution_type: String, // "order_refund", "ticket_settle", "ticket_refund"
    pub timestamp: i64,
}