use anchor_lang::prelude::*;
use anchor_lang::prelude::AccountsClose;
use anchor_spl::token::{Token, TokenAccount, Transfer, transfer};
use crate::universal::state::*;
use crate::universal::errors::UniversalOrderError;
use crate::universal::utils::auto_close::auto_close_if_needed;

/// Cancel a ticket - ONLY FiatGuy can cancel, ONLY before they sign
/// Always refunds tokens to CryptoGuy and auto-closes order + vault
pub fn cancel_ticket(
    ctx: Context<CancelTicket>,
) -> Result<()> {
    let ticket = &ctx.accounts.ticket;
    let canceller = &ctx.accounts.canceller;
    let clock = Clock::get()?;
    
    // Snapshot order fields
    let order_key = ctx.accounts.order.key();
    let order_creator = ctx.accounts.order.creator;
    let order_mint = ctx.accounts.order.crypto_mint;
    let order_id_le = ctx.accounts.order.order_id.to_le_bytes();
    let order_bump = ctx.accounts.order.bump;
    let is_sell = ctx.accounts.order.is_sell_order;

    require!(ticket.order == order_key, UniversalOrderError::Unauthorized);

    // Identify parties
    let crypto_guy = if is_sell { order_creator } else { ticket.acceptor };
    let fiat_guy = if is_sell { ticket.acceptor } else { order_creator };

    // CHECK: Only FiatGuy can cancel
    require!(canceller.key() == fiat_guy, UniversalOrderError::Unauthorized);
    
    // CHECK: Can only cancel before FiatGuy signs
    require!(!ticket.fiat_guy_signed, UniversalOrderError::CannotCancel);

    // Get CryptoGuy's token account for refund
    let crypto_guy_ata = ctx.accounts.crypto_guy_token_account.as_ref()
        .ok_or(UniversalOrderError::TokenAccountRequired)?;
    require!(crypto_guy_ata.mint == order_mint, UniversalOrderError::InvalidTokenAccount);
    require!(crypto_guy_ata.owner == crypto_guy, UniversalOrderError::Unauthorized);

    // Prepare PDA signer
    let signer_seeds = &[
        b"universal_order",
        order_creator.as_ref(),
        order_mint.as_ref(),
        order_id_le.as_ref(),
        &[order_bump],
    ];
    let signer = &[&signer_seeds[..]];

    // Refund tokens from vault to CryptoGuy
    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: crypto_guy_ata.to_account_info(),
            authority: ctx.accounts.order.to_account_info(),
        },
        signer,
    );
    transfer(transfer_ctx, ticket.amount)?;

    // Emit cancellation event
    emit!(crate::universal::events::TicketCancelled {
        order: order_key,
        ticket: ticket.key(),
        canceller: canceller.key(),
        amount: ticket.amount,
        refunded: true,
        timestamp: clock.unix_timestamp,
    });

    // Close ticket (rent → admin)
    ticket.close(ctx.accounts.admin_rent_receiver.to_account_info())?;

    // AUTO-CLOSE: Cancel means order is cancelled (always close)
    auto_close_if_needed(
        &mut ctx.accounts.order,
        &ctx.accounts.vault,
        &ctx.accounts.admin_rent_receiver.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        true, // is_refund = true (always close on cancel)
    )?;

    Ok(())
}

#[derive(Accounts)]
pub struct CancelTicket<'info> {
    /// FiatGuy who cancels
    #[account(mut)]
    pub canceller: Signer<'info>,

    /// CHECK: Admin wallet receives rent back (validated by address constraint)
    #[account(
        mut,
        address = crate::constants::ADMIN_PUBKEY @ UniversalOrderError::Unauthorized
    )]
    pub admin_rent_receiver: UncheckedAccount<'info>,

    /// Parent order (will be closed)
    #[account(
        mut,
        seeds = [b"universal_order", order.creator.as_ref(), order.crypto_mint.as_ref(), order.order_id.to_le_bytes().as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, UniversalOrder>,

    /// Vault (will be closed after refund)
    #[account(
        mut,
        seeds = [b"vault", order.key().as_ref()],
        bump,
        constraint = vault.mint == order.crypto_mint
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Ticket to cancel (will be closed)
    #[account(
        mut,
        seeds = [b"ticket", order.key().as_ref(), ticket.ticket_id.to_le_bytes().as_ref()],
        bump = ticket.bump
    )]
    pub ticket: Account<'info, FillTicket>,

    /// CryptoGuy's token account (receives refund)
    #[account(mut)]
    pub crypto_guy_token_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}
