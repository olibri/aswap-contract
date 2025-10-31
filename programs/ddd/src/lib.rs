mod errors;
mod events;
mod types;
mod constants;

// Universal Order System - New simplified architecture
pub mod universal;
pub use universal::*;


use anchor_lang::prelude::*;

declare_id!("2sy9dsjm6fsqeMEL49FWJkXz5eavc5qaHD1xyactQuP5");

#[program]
pub mod ddd {
    use super::*;
    
    /// Accept offer and lock crypto (creates order + vault + ticket, locks tokens)
    pub fn accept_offer_and_lock(
        ctx: Context<AcceptOfferAndLock>,
        order_id: u64,
        ticket_id: u64,
        crypto_amount: u64,
        fiat_amount: u64,
        is_sell_order: bool,
        creator: Pubkey,
        fiat_guy: Pubkey,
    ) -> Result<()> {
        accept_offer_and_lock::accept_offer_and_lock(ctx, order_id, ticket_id, crypto_amount, fiat_amount, is_sell_order, creator, fiat_guy)
    }

    /// Sign a specific ticket; settles on second signature; auto-closes on completion
    pub fn sign_universal_ticket(
        ctx: Context<SignTicket>,
    ) -> Result<()> {
        sign_ticket(ctx)
    }

    /// Cancel a ticket (FiatGuy only, before signing); refunds to CryptoGuy; auto-closes order
    pub fn cancel_universal_ticket(
        ctx: Context<CancelTicket>,
    ) -> Result<()> {
        cancel_ticket(ctx)
    }

    /// Admin resolve specific ticket - force settle to fiat or refund to crypto
    pub fn admin_resolve_universal_ticket(
        ctx: Context<AdminResolveTicket>,
        release_to_fiat_guy: bool,
    ) -> Result<()> {
        admin_resolve_ticket(ctx, release_to_fiat_guy)
    }
}

#[derive(Accounts)]
pub struct Initialize {}
