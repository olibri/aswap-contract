use anchor_lang::prelude::*;

#[event] 
pub struct ClaimCanceled  { pub escrow: Pubkey, pub buyer:  Pubkey, pub ts: i64 }
#[event]
pub struct OfferCanceled  { pub escrow: Pubkey, pub seller: Pubkey, pub amount: u64, pub ts: i64 }

#[event]
pub struct EscrowInitialized {
    pub escrow: Pubkey,
    pub seller: Pubkey,
    pub buyer:  Pubkey,
    pub token_mint: Pubkey,
    pub fiat_code: [u8; 8],
    pub amount: u64,
    pub price:  u64,
    pub deal_id: u64,
    pub ts: i64,
}

#[event]
pub struct OfferInitialized {
    pub escrow: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub token_mint: Pubkey,
    pub fiat_code: [u8; 8],
    pub amount: u64,
    pub price: u64,
    pub deal_id: u64,
    pub ts: i64,
    pub offer_type: u8,
}

#[event] pub struct OfferClaimed  { pub escrow: Pubkey, pub buyer: Pubkey, pub deal_id: u64 }
#[event] pub struct BuyerSigned   { pub escrow: Pubkey, pub deal_id: u64 }
#[event] pub struct SellerSigned  { pub escrow: Pubkey, pub deal_id: u64 }
#[event]
pub struct FundsReleased {
    pub escrow: Pubkey,
    pub buyer:  Pubkey,
    pub amount: u64,
    pub deal_id: u64,
    pub ts: i64,
}

#[event]
pub struct FillForceCanceled {
    pub parent_offer: Pubkey,
    pub fill: Pubkey,
    pub amount: u64,
    pub ts: i64,
}

#[event]
pub struct FillCanceled {
    pub parent_offer: Pubkey,
    pub fill:         Pubkey,
    pub amount:       u64,
    pub ts:           i64,
}

#[event]
pub struct EscrowCanceled {
    pub escrow: Pubkey,
    pub amount: u64,
    pub seller: Pubkey,
}

#[event]
pub struct AdminResolved {
    pub escrow:    Pubkey,
    pub to:        Pubkey,
    pub amount:    u64,
    pub remaining: u64,
    pub ts:        i64,
}
