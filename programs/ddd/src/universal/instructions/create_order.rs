use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Mint, Transfer, transfer};
use crate::universal::state::*;
use crate::universal::errors::UniversalOrderError;

/// Create Universal Order - works for both Sell and Buy orders
/// CryptoGuy creates Sell order (locks crypto immediately)
/// FiatGuy creates Buy order (no locking, just creates order)
pub fn create_order(
    ctx: Context<CreateOrder>,
    order_id: u64,
    crypto_amount: u64,
    fiat_amount: u64,
    is_sell_order: bool,
) -> Result<()> {
    let order = &mut ctx.accounts.order;
    let creator = &ctx.accounts.creator;
    let mint = &ctx.accounts.mint;
    let clock = Clock::get()?;

    // Initialize order
    order.creator = creator.key();
    order.acceptor = None;
    order.crypto_mint = mint.key();
    order.is_sell_order = is_sell_order;
    order.crypto_amount = crypto_amount;
    order.fiat_amount = fiat_amount;
    order.order_id = order_id;
    order.status = OrderStatus::Created;
    order.crypto_guy_signed = false;
    order.fiat_guy_signed = false;
    order.filled_amount = 0;
    order.pending_amount = 0;
    order.reserved_amount = 0; // For parallel tickets
    order.created_at = clock.unix_timestamp;
    order.updated_at = clock.unix_timestamp;
    order.last_action_ts = clock.unix_timestamp;
    order.daily_fill_count = 0;
    order.daily_reset_ts = clock.unix_timestamp;
    order.vault = ctx.accounts.vault.key();
    order.bump = ctx.bumps.order;

    // If this is a Sell order, CryptoGuy (creator) must lock crypto immediately
    if is_sell_order {
        let creator_token_account = ctx.accounts.creator_token_account.as_ref()
            .ok_or(UniversalOrderError::InvalidOrderType)?;
        require!(
            creator_token_account.amount >= crypto_amount,
            UniversalOrderError::InsufficientBalance
        );

        // Transfer crypto from creator to vault
        let creator_token_account = ctx.accounts.creator_token_account.as_ref().unwrap();
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: creator_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: creator.to_account_info(),
            },
        );
        
        transfer(transfer_ctx, crypto_amount)?;
        
        msg!("Sell Order Created: CryptoGuy {} locked {} tokens", creator.key(), crypto_amount);
    } else {
        msg!("Buy Order Created: FiatGuy {} wants to buy {} tokens", creator.key(), crypto_amount);
    }

    // Emit event
    emit!(crate::universal::events::UniversalOrderCreated {
        order: order.key(),
        creator: creator.key(),
        crypto_mint: mint.key(),
        is_sell_order,
        crypto_amount,
        fiat_amount,
        order_id,
        vault: ctx.accounts.vault.key(),
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(order_id: u64, crypto_amount: u64, fiat_amount: u64, is_sell_order: bool)]
pub struct CreateOrder<'info> {

    /// Creator of the order (CryptoGuy for Sell, FiatGuy for Buy)
    pub creator: Signer<'info>,

    /// Admin wallet that pays rent (hardcoded address)
    #[account(
        mut,
        address = crate::constants::ADMIN_PUBKEY @ UniversalOrderError::Unauthorized
    )]
    pub fee_payer: Signer<'info>,

    /// CHECK:
    #[account(
        init,
        payer = fee_payer,
        space = UniversalOrder::SPACE,
        seeds = [b"universal_order", creator.key().as_ref(), mint.key().as_ref(), order_id.to_le_bytes().as_ref()],
        bump
    )]
    pub order: Account<'info, UniversalOrder>,

    /// CHECK:
    pub mint: Account<'info, Mint>,

    /// CHECK:
    #[account(
        init,
        payer = fee_payer,
        token::mint = mint,
        token::authority = order, // Order PDA is the authority
        seeds = [b"vault", order.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    // Only required for Sell orders (CryptoGuy locking tokens)
    /// CHECK:
    #[account(
        mut,
        constraint = if is_sell_order { 
            creator_token_account.mint == mint.key() && creator_token_account.owner == creator.key() 
        } else { 
            true // Not required for Buy orders
        }
    )]
    pub creator_token_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// Errors are defined in universal/errors.rs