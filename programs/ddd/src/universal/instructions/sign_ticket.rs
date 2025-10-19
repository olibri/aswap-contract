use anchor_lang::prelude::*;
use anchor_lang::prelude::AccountsClose; // for conditional account close
use anchor_spl::token::{Token, TokenAccount, Transfer, transfer};
use crate::universal::state::*;
use crate::universal::errors::UniversalOrderError;
use crate::universal::utils::fees::calculate_fee;
use crate::universal::utils::auto_close::auto_close_if_needed;

/// Sign a specific ticket; on both signatures, settle that ticket amount
pub fn sign_ticket(
    ctx: Context<SignTicket>,
) -> Result<()> {
    let ticket = &mut ctx.accounts.ticket;
    let signer = &ctx.accounts.signer;
    let clock = Clock::get()?;
    // Snapshot order fields to avoid borrow conflicts
    let order_key = ctx.accounts.order.key();
    let order_creator = ctx.accounts.order.creator;
    let order_mint = ctx.accounts.order.crypto_mint;
    let order_id_le = ctx.accounts.order.order_id.to_le_bytes();
    let order_bump = ctx.accounts.order.bump;
    let is_sell = ctx.accounts.order.is_sell_order;

    // CHECK: Ticket must belong to order
    require!(ticket.order == order_key, UniversalOrderError::Unauthorized);

    // Identify roles
    let crypto_guy = if is_sell { order_creator } else { ticket.acceptor };
    let fiat_guy   = if is_sell { ticket.acceptor } else { order_creator };

    // Mark signature
    if signer.key() == crypto_guy {
        // Business rule: FiatGuy must sign first. If crypto tries to sign before fiat, error.
        require!(ticket.fiat_guy_signed, UniversalOrderError::SignatureRequired);
        require!(!ticket.crypto_guy_signed, UniversalOrderError::RaceCondition);
        ticket.crypto_guy_signed = true;
    } else if signer.key() == fiat_guy {
        require!(!ticket.fiat_guy_signed, UniversalOrderError::RaceCondition);
        ticket.fiat_guy_signed = true;
    } else {
        return Err(UniversalOrderError::Unauthorized.into());
    }

    // We'll update order.updated_at and counters after potential CPI using a mutable borrow

    // Emit signing event
    emit!(crate::universal::events::TicketSigned {
    order: order_key,
        ticket: ticket.key(),
        signer: signer.key(),
        is_crypto_guy: signer.key() == crypto_guy,
        is_fiat_guy: signer.key() == fiat_guy,
        both_signed: ticket.crypto_guy_signed && ticket.fiat_guy_signed,
        timestamp: clock.unix_timestamp,
    });

    // If both signed -> settle this ticket
    if ticket.crypto_guy_signed && ticket.fiat_guy_signed {
        let amount = ticket.amount;

        // CHECK: FiatGuy ATA provided
        let fiat_guy_token_account = ctx.accounts.fiat_guy_token_account.as_ref()
            .ok_or(UniversalOrderError::TokenAccountRequired)?;
        require!(fiat_guy_token_account.mint == order_mint, UniversalOrderError::InvalidTokenAccount);
        require!(fiat_guy_token_account.owner == fiat_guy, UniversalOrderError::Unauthorized);

        // CHECK: Admin fee account provided
        let admin_fee_account = ctx.accounts.admin_fee_account.as_ref()
            .ok_or(UniversalOrderError::TokenAccountRequired)?;
        require!(admin_fee_account.mint == order_mint, UniversalOrderError::InvalidTokenAccount);
        require!(admin_fee_account.owner == crate::constants::ADMIN_PUBKEY, UniversalOrderError::Unauthorized);

        // Calculate 0.2% fee
        let (fee_amount, net_amount) = calculate_fee(amount)?;

        // Prepare PDA signer: the vault's owner is the order PDA
        let order_signer_seeds = &[
            b"universal_order",
            order_creator.as_ref(),
            order_mint.as_ref(),
            order_id_le.as_ref(),
            &[order_bump],
        ];
        let order_signer = &[&order_signer_seeds[..]];

        // Transfer 1: 99.8% to FiatGuy
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: fiat_guy_token_account.to_account_info(),
                authority: ctx.accounts.order.to_account_info(),
            },
            order_signer,
        );
        transfer(transfer_ctx, net_amount)?;

        // Transfer 2: 0.2% to Admin (fee)
        let fee_transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: admin_fee_account.to_account_info(),
                authority: ctx.accounts.order.to_account_info(),
            },
            order_signer,
        );
        transfer(fee_transfer_ctx, fee_amount)?;

        // Update order counters (now take a mutable borrow)
        {
            let order = &mut ctx.accounts.order;
            order.filled_amount = order.filled_amount.saturating_add(amount);
            order.reserved_amount = order.reserved_amount.saturating_sub(amount);
        }

        // Emit settlement event
        emit!(crate::universal::events::TicketSettled {
            order: order_key,
            ticket: ticket.key(),
            amount,
            fee_amount,
            net_amount,
            fiat_guy,
            crypto_guy,
            total_filled: ctx.accounts.order.filled_amount,
            timestamp: clock.unix_timestamp,
        });

        // Close the ticket account returning rent to admin (who paid for ticket creation)
        ticket.close(ctx.accounts.admin_rent_receiver.to_account_info())?;

        // AUTO-CLOSE order if fully completed
        auto_close_if_needed(
            &mut ctx.accounts.order,
            &ctx.accounts.vault,
            &ctx.accounts.admin_rent_receiver.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            false, // is_refund = false (only close if completed)
        )?;
        
        // Check if order was closed by auto_close
        let order_closed = ctx.accounts.order.to_account_info().data_is_empty();
        if order_closed {
            return Ok(());
        }
    }

    // Finally, update order timestamp (if not auto-closed)
    {
        let order = &mut ctx.accounts.order;
        order.updated_at = clock.unix_timestamp;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct SignTicket<'info> {
    // CHECK:
    #[account(mut)]
    pub signer: Signer<'info>,

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

    /// CHECK: Vault PDA
    #[account(
        mut,
        seeds = [b"vault", order.key().as_ref()],
        bump,
        constraint = vault.mint == order.crypto_mint
    )]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: Ticket PDA
    #[account(
        mut,
        seeds = [b"ticket", order.key().as_ref(), ticket.ticket_id.to_le_bytes().as_ref()],
        bump = ticket.bump
    )]
    pub ticket: Account<'info, FillTicket>,

    // FiatGuy's token account (where crypto will be sent)
    #[account(mut)]
    pub fiat_guy_token_account: Option<Account<'info, TokenAccount>>,

    // Admin's token account (for 0.2% fee)
    #[account(mut)]
    pub admin_fee_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}
