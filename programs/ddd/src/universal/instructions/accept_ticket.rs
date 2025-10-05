use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Transfer, transfer};
use crate::universal::state::*;
use crate::universal::errors::UniversalOrderError;
use crate::constants::{FILL_COOLDOWN_SECS, MAX_FILLS_PER_DAY, SECONDS_PER_DAY};

/// Accept Ticket - creates a parallel partial fill reservation
pub fn accept_ticket(
    ctx: Context<AcceptTicket>,
    ticket_id: u64,
    amount: u64,
) -> Result<()> {
    let order = &mut ctx.accounts.order;
    let ticket = &mut ctx.accounts.ticket;
    let acceptor = &ctx.accounts.acceptor;
    let clock = Clock::get()?;

    // CHECK: Order must be open for new reservations
    require!(order.status == OrderStatus::Created || order.status == OrderStatus::Accepted || order.status == OrderStatus::BothSigned, UniversalOrderError::InvalidOrderStatus);
    require!(amount <= order.available_amount(), UniversalOrderError::InvalidAmount);
    require!(acceptor.key() != order.creator, UniversalOrderError::Unauthorized);

    // Rate limiting: enforce cooldown and daily caps
    // Reset daily window if a day has passed
    if clock.unix_timestamp - order.daily_reset_ts >= SECONDS_PER_DAY {
        order.daily_fill_count = 0;
        order.daily_reset_ts = clock.unix_timestamp;
    }
    require!(clock.unix_timestamp - order.last_action_ts >= FILL_COOLDOWN_SECS, UniversalOrderError::RaceCondition);
    require!((order.daily_fill_count as u16) < MAX_FILLS_PER_DAY, UniversalOrderError::RaceCondition);

    // Initialize ticket
    ticket.order = order.key();
    ticket.acceptor = acceptor.key();
    ticket.amount = amount;
    ticket.crypto_guy_signed = false;
    ticket.fiat_guy_signed = false;
    ticket.ticket_id = ticket_id;
    ticket.created_at = clock.unix_timestamp;
    ticket.bump = ctx.bumps.ticket;

    // Concurrency guard: ensure we don't over-reserve if parallel accepts happen
    let remaining = order.remaining_amount();
    // sanity: existing reserved cannot exceed remaining
    require!(order.reserved_amount <= remaining, UniversalOrderError::RaceCondition);
    let new_reserved = order
        .reserved_amount
        .checked_add(amount)
        .ok_or(UniversalOrderError::RaceCondition)?;
    require!(new_reserved <= remaining, UniversalOrderError::RaceCondition);

    // Reserve amount on order (after guard)
    order.reserved_amount = new_reserved;
    order.updated_at = clock.unix_timestamp;
    order.last_action_ts = clock.unix_timestamp;
    order.daily_fill_count = order.daily_fill_count.saturating_add(1);

    // Emit event
    emit!(crate::universal::events::TicketAccepted {
        order: order.key(),
        ticket: ticket.key(),
        acceptor: acceptor.key(),
        ticket_id,
        amount,
        is_sell_order: order.is_sell_order,
        timestamp: clock.unix_timestamp,
    });

    // For Buy orders, acceptor is CryptoGuy and must lock crypto now
    if !order.is_sell_order {
        let acceptor_token_account = ctx.accounts.acceptor_token_account.as_ref()
            .ok_or(UniversalOrderError::TokenAccountRequired)?;
        // CHECK: Correct mint & owner
        require!(acceptor_token_account.mint == order.crypto_mint, UniversalOrderError::InvalidTokenAccount);
        require!(acceptor_token_account.owner == acceptor.key(), UniversalOrderError::Unauthorized);
        require!(acceptor_token_account.amount >= amount, UniversalOrderError::InsufficientBalance);

        // Transfer crypto to vault
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: acceptor_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: acceptor.to_account_info(),
            },
        );
        transfer(transfer_ctx, amount)?;
    }

    Ok(())
}

#[derive(Accounts)]
#[instruction(ticket_id: u64, amount: u64)]
pub struct AcceptTicket<'info> {
    /// Acceptor (user) - just signs, doesn't pay
    pub acceptor: Signer<'info>,

    /// Admin wallet that pays rent (hardcoded address)
    #[account(
        mut,
        address = crate::constants::ADMIN_PUBKEY @ UniversalOrderError::Unauthorized
    )]
    pub fee_payer: Signer<'info>,

    /// CHECK: Parent order PDA
    #[account(
        mut,
        seeds = [b"universal_order", order.creator.as_ref(), order.crypto_mint.as_ref(), order.order_id.to_le_bytes().as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, UniversalOrder>,

    /// CHECK: Vault PDA for the order
    #[account(
        mut,
        seeds = [b"vault", order.key().as_ref()],
        bump,
        constraint = vault.mint == order.crypto_mint
    )]
    pub vault: Account<'info, TokenAccount>,

    /// CHECK: Ticket PDA (admin pays rent)
    #[account(
        init,
        payer = fee_payer,
        space = FillTicket::SPACE,
        seeds = [b"ticket", order.key().as_ref(), ticket_id.to_le_bytes().as_ref()],
        bump
    )]
    pub ticket: Account<'info, FillTicket>,

    // For Buy orders only
    // CHECK: Validated in logic
    #[account(mut)]
    pub acceptor_token_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
