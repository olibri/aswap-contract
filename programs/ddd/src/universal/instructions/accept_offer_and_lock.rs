use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Mint, transfer, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use crate::universal::state::*;
use crate::universal::errors::UniversalOrderError;
use crate::universal::events::OfferAccepted;

/// Accept an offer from DB and lock crypto for the first ticket
/// This replaces the old create_order + lock_crypto_for_ticket flow
/// 
/// Flow:
/// 1. Creates order PDA with offer details
/// 2. Creates vault PDA for locked tokens
/// 3. Creates first ticket PDA
/// 4. CryptoGuy locks tokens into vault
/// 5. Emits OfferAccepted event
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
    let order = &mut ctx.accounts.order;
    let ticket = &mut ctx.accounts.ticket;
    let locker = &ctx.accounts.locker;
    let clock = Clock::get()?;

    // Validate amounts
    require!(crypto_amount > 0, UniversalOrderError::InvalidAmount);
    require!(fiat_amount > 0, UniversalOrderError::InvalidAmount);
    require!(ticket_id > 0, UniversalOrderError::InvalidAmount);

    // CryptoGuy is always the one who locks tokens
    let crypto_guy = locker.key();
    
    // Determine actual fiat_guy based on order type
    let actual_fiat_guy = if is_sell_order {
        fiat_guy    // SELL: fiat_guy parameter is the buyer
    } else {
        creator     // BUY: creator is the buyer (FiatGuy)
    };

    // CHECK: CryptoGuy cannot lock for themselves
    require!(crypto_guy != actual_fiat_guy, UniversalOrderError::Unauthorized);

    // CHECK: For SELL orders, locker must be creator
    // For BUY orders, locker must NOT be creator
    if is_sell_order {
        require!(crypto_guy == creator, UniversalOrderError::Unauthorized);
    } else {
        require!(crypto_guy != creator, UniversalOrderError::Unauthorized);
    }

    // Initialize order
    order.creator = creator;
    order.crypto_mint = ctx.accounts.mint.key();
    order.crypto_amount = crypto_amount;
    order.fiat_amount = fiat_amount;
    order.is_sell_order = is_sell_order;
    order.filled_amount = 0;
    order.reserved_amount = crypto_amount; // First ticket reserves full amount
    order.order_id = order_id;
    order.created_at = clock.unix_timestamp;
    order.updated_at = clock.unix_timestamp;
    order.bump = ctx.bumps.order;

    // Initialize ticket
    ticket.order = order.key();
    // Acceptor is the one who accepts the offer:
    // SELL: acceptor = FiatGuy (buyer accepts seller's offer)
    // BUY: acceptor = CryptoGuy (seller accepts buyer's offer)
    ticket.acceptor = if is_sell_order { actual_fiat_guy } else { crypto_guy };
    ticket.amount = crypto_amount;
    ticket.crypto_guy_signed = false;
    ticket.fiat_guy_signed = false;
    ticket.ticket_id = ticket_id;
    ticket.created_at = clock.unix_timestamp;
    ticket.bump = ctx.bumps.ticket;

    // Transfer tokens from CryptoGuy to vault
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.locker_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: locker.to_account_info(),
        },
    );
    transfer(transfer_ctx, crypto_amount)?;

    // Emit event with all data
    emit!(OfferAccepted {
        order: order.key(),
        order_id,
        creator,
        crypto_mint: ctx.accounts.mint.key(),
        vault: ctx.accounts.vault.key(),
        is_sell_order,
        crypto_amount,
        fiat_amount,
        ticket: ticket.key(),
        ticket_id,
        locked_amount: crypto_amount,
        crypto_guy,
        fiat_guy: actual_fiat_guy,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(order_id: u64, ticket_id: u64, crypto_amount: u64, fiat_amount: u64, is_sell_order: bool, creator: Pubkey)]
pub struct AcceptOfferAndLock<'info> {
    /// CryptoGuy who locks the tokens (signer)
    #[account(mut)]
    pub locker: Signer<'info>,

    /// Admin pays rent for order, vault, and ticket creation
    #[account(
        mut,
        address = crate::constants::ADMIN_PUBKEY @ UniversalOrderError::Unauthorized
    )]
    pub fee_payer: Signer<'info>,

    /// New order PDA (created here)
    #[account(
        init,
        payer = fee_payer,
        space = UniversalOrder::SPACE,
        seeds = [b"universal_order", creator.as_ref(), mint.key().as_ref(), order_id.to_le_bytes().as_ref()],
        bump
    )]
    pub order: Account<'info, UniversalOrder>,

    /// Crypto mint (USDC, etc.)
    pub mint: Account<'info, Mint>,

    /// Vault PDA (created here, holds locked tokens)
    #[account(
        init,
        payer = fee_payer,
        seeds = [b"vault", order.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = order
    )]
    pub vault: Account<'info, TokenAccount>,

    /// New ticket PDA (created here)
    #[account(
        init,
        payer = fee_payer,
        space = FillTicket::SPACE,
        seeds = [b"ticket", order.key().as_ref(), ticket_id.to_le_bytes().as_ref()],
        bump
    )]
    pub ticket: Account<'info, FillTicket>,

    /// CryptoGuy's token account (source of locked tokens)
    #[account(
        mut,
        constraint = locker_token_account.mint == mint.key() @ UniversalOrderError::InvalidTokenAccount,
        constraint = locker_token_account.owner == locker.key() @ UniversalOrderError::Unauthorized,
        constraint = locker_token_account.amount >= crypto_amount @ UniversalOrderError::InsufficientBalance
    )]
    pub locker_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
