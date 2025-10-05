use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Transfer, transfer};
use crate::universal::state::*;
use crate::universal::errors::UniversalOrderError;

/// Cancel a ticket; refund logic for Buy orders; decrease reserved
pub fn cancel_ticket(
    ctx: Context<CancelTicket>,
) -> Result<()> {
    let ticket = &mut ctx.accounts.ticket;
    let canceller = &ctx.accounts.canceller;
    // Snapshot order fields
    let order_key = ctx.accounts.order.key();
    let order_creator = ctx.accounts.order.creator;
    let order_mint = ctx.accounts.order.crypto_mint;
    let order_id_le = ctx.accounts.order.order_id.to_le_bytes();
    let order_bump = ctx.accounts.order.bump;
    let is_sell = ctx.accounts.order.is_sell_order;

    // CHECK: Ticket must belong to order
    require!(ticket.order == order_key, UniversalOrderError::Unauthorized);

    // Permission: creator or acceptor can cancel if not both signed
    let is_creator = canceller.key() == order_creator;
    let is_acceptor = canceller.key() == ticket.acceptor;
    require!(is_creator || is_acceptor, UniversalOrderError::Unauthorized);
    // Business rule: once FiatGuy has signed (confirmed fiat sent), no side may cancel
    require!(!ticket.fiat_guy_signed, UniversalOrderError::CannotCancel);

    // For Buy orders, if funds were locked on accept, refund acceptor
    if !is_sell && ticket.amount > 0 {
        let acceptor_ata = ctx.accounts.acceptor_token_account.as_ref()
            .ok_or(UniversalOrderError::TokenAccountRequired)?;
        require!(acceptor_ata.mint == order_mint, UniversalOrderError::InvalidTokenAccount);
        require!(acceptor_ata.owner == ticket.acceptor, UniversalOrderError::Unauthorized);

        // Order PDA is the vault's authority
        let signer_seeds = &[
            b"universal_order",
            order_creator.as_ref(),
            order_mint.as_ref(),
            order_id_le.as_ref(),
            &[order_bump],
        ];
        let signer = &[&signer_seeds[..]];

        // Transfer back amount to acceptor
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: acceptor_ata.to_account_info(),
                authority: ctx.accounts.order.to_account_info(),
            },
            signer,
        );
        transfer(transfer_ctx, ticket.amount)?;
    }

    // Decrease reserved after CPI using a mutable borrow
    {
        let order = &mut ctx.accounts.order;
        order.reserved_amount = order.reserved_amount.saturating_sub(ticket.amount);
    }

    // Emit cancellation event
    emit!(crate::universal::events::TicketCancelled {
        order: order_key,
        ticket: ticket.key(),
        canceller: canceller.key(),
        amount: ticket.amount,
        refunded: !is_sell && ticket.amount > 0, // Buy order refund happened
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct CancelTicket<'info> {
    // CHECK:
    #[account(mut)]
    pub canceller: Signer<'info>,

    /// CHECK: Admin wallet receives rent back (hardcoded address)
    #[account(
        mut,
        address = crate::constants::ADMIN_PUBKEY @ UniversalOrderError::Unauthorized
    )]
    pub admin_rent_receiver: UncheckedAccount<'info>,

    /// CHECK: Parent order
    #[account(
        mut,
        seeds = [b"universal_order", order.creator.as_ref(), order.crypto_mint.as_ref(), order.order_id.to_le_bytes().as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, UniversalOrder>,

    /// CHECK: Vault
    #[account(
        mut,
        seeds = [b"vault", order.key().as_ref()],
        bump,
        constraint = vault.mint == order.crypto_mint
    )]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: Ticket to cancel (rent returns to admin)
    #[account(
        mut,
        close = admin_rent_receiver,
        seeds = [b"ticket", order.key().as_ref(), ticket.ticket_id.to_le_bytes().as_ref()],
        bump = ticket.bump
    )]
    pub ticket: Account<'info, FillTicket>,

    // For Buy orders refund
    #[account(mut)]
    pub acceptor_token_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}
