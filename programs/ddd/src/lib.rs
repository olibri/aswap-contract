mod errors;
mod events;
mod types;
mod constants;

// Universal Order System - New simplified architecture
pub mod universal;
pub use universal::*;


use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("RVCEK6tHXkRgLFwK2oYyPyvT3nHcZ5CaFzTKCn96WCe");

#[program]
pub mod ddd {
    use super::*;
    pub fn create_universal_order(
        ctx: Context<CreateOrder>,
        order_id: u64,
        crypto_amount: u64,
        fiat_amount: u64,
        is_sell_order: bool,
    ) -> Result<()> {
        crate::universal::instructions::create_order::create_order(ctx, order_id, crypto_amount, fiat_amount, is_sell_order)
    }


    /// Accept a parallel ticket on universal order
    pub fn accept_universal_ticket(
        ctx: Context<AcceptTicket>,
        ticket_id: u64,
        amount: u64,
    ) -> Result<()> {
        accept_ticket(ctx, ticket_id, amount)
    }

    /// Sign a specific ticket; settles on second signature
    pub fn sign_universal_ticket(
        ctx: Context<SignTicket>,
    ) -> Result<()> {
        sign_ticket(ctx)
    }

    /// Cancel a ticket; refunds for buy orders
    pub fn cancel_universal_ticket(
        ctx: Context<CancelTicket>,
    ) -> Result<()> {
        cancel_ticket(ctx)
    }

    /// Cancel the remaining unreserved part of an order (or whole order if possible)
    pub fn cancel_universal_order(
        ctx: Context<CancelOrder>,
    ) -> Result<()> {
        cancel_order(ctx)
    }

    /// Admin resolve Universal Order (order-level) - emergency admin intervention
    pub fn admin_resolve_universal_order(
        ctx: Context<AdminResolveOrder>,
        amount: u64,
    ) -> Result<()> {
        admin_resolve_order(ctx, amount)
    }

    /// Admin resolve specific ticket - force settle to fiat or refund to crypto
    pub fn admin_resolve_universal_ticket(
        ctx: Context<AdminResolveTicket>,
        release_to_fiat_guy: bool,
    ) -> Result<()> {
        admin_resolve_ticket(ctx, release_to_fiat_guy)
    }

    /// Close universal order account and reclaim rent (dust threshold applies)
    pub fn close_universal_order(
        ctx: Context<CloseOrder>,
    ) -> Result<()> {
        close_order(ctx)
    }
}

#[derive(Accounts)]
pub struct Initialize {}
