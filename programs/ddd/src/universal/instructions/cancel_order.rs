use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Transfer, transfer, CloseAccount, close_account};
use crate::universal::state::*;
use crate::universal::errors::UniversalOrderError;

/// Cancel all or remaining unreserved amount of an order by its creator
/// Rules:
/// - Sell order (creator is CryptoGuy): can cancel remaining unreserved amount anytime; tokens are returned from vault
///   - If any active tickets exist (reserved_amount > 0), only the non-reserved portion is cancelled now; order stays open for tickets
/// - Buy order (creator is FiatGuy): can cancel the order only when there are no active tickets (reserved_amount == 0)
///   - No funds to return on-chain; just marks as cancelled when nothing left to fill
pub fn cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
    let creator = &ctx.accounts.creator;
    // Snapshot order fields
    let is_sell = ctx.accounts.order.is_sell_order;
    let order_remaining = ctx.accounts.order.remaining_amount();
    let order_reserved = ctx.accounts.order.reserved_amount;
    let order_creator = ctx.accounts.order.creator;
    let order_mint = ctx.accounts.order.crypto_mint;
    let order_id_le = ctx.accounts.order.order_id.to_le_bytes();
    let order_bump = ctx.accounts.order.bump;

    // Only creator can cancel order
    require!(creator.key() == order_creator, UniversalOrderError::Unauthorized);

    // Nothing to cancel if already fully filled
    let remaining = order_remaining;
    require!(remaining > 0, UniversalOrderError::OrderCompleted);

    if is_sell {
        // Seller locked total crypto_amount up-front in vault
        // Amount still in vault that is not reserved by active tickets
    let releasable = remaining.saturating_sub(order_reserved);
        require!(releasable > 0, UniversalOrderError::CannotCancel);

        // Transfer releasable back to creator from vault PDA
        // Order PDA is the vault's authority
        let order_signer_seeds = &[
            b"universal_order",
            order_creator.as_ref(),
            order_mint.as_ref(),
            order_id_le.as_ref(),
            &[order_bump],
        ];
        let signer = &[&order_signer_seeds[..]];

        let creator_ata = ctx.accounts.creator_token_account.as_ref()
            .ok_or(UniversalOrderError::TokenAccountRequired)?;
    require!(creator_ata.mint == order_mint, UniversalOrderError::InvalidTokenAccount);
    require!(creator_ata.owner == creator.key(), UniversalOrderError::Unauthorized);

        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: creator_ata.to_account_info(),
                authority: ctx.accounts.order.to_account_info(),
            },
            signer,
        );
        transfer(cpi, releasable)?;

        // Reduce the target amount to what is still reserved + already filled
        // Effectively: crypto_amount = filled + reserved, so remaining becomes 0
        {
            let order = &mut ctx.accounts.order;
            order.crypto_amount = order.filled_amount.saturating_add(order.reserved_amount);
        }

        // If no active tickets, mark as Cancelled; otherwise keep as Accepted
        {
            let order = &mut ctx.accounts.order;
            if order.reserved_amount == 0 {
                order.status = OrderStatus::Cancelled;
            }
        }

        // Emit cancellation event
        emit!(crate::universal::events::OrderCancelled {
            order: ctx.accounts.order.key(),
            creator: creator.key(),
            amount_returned: releasable,
            is_sell_order: true,
            remaining_after: {
                let order = &ctx.accounts.order;
                order.remaining_amount()
            },
            timestamp: Clock::get()?.unix_timestamp,
        });
    } else {
        // Buy order: creator is FiatGuy, no funds on-chain to return
        // Can cancel only when there are no active tickets
        require!(order_reserved == 0, UniversalOrderError::CannotCancel);

        // Set crypto_amount = filled so remaining becomes 0 and mark Cancelled
        let filled = ctx.accounts.order.filled_amount;
        {
            let order = &mut ctx.accounts.order;
            order.crypto_amount = filled;
            order.status = OrderStatus::Cancelled;
        }

        // Emit cancellation event
        emit!(crate::universal::events::OrderCancelled {
            order: ctx.accounts.order.key(),
            creator: creator.key(),
            amount_returned: 0, // Buy orders don't return tokens
            is_sell_order: false,
            remaining_after: 0,
            timestamp: Clock::get()?.unix_timestamp,
        });
    }

    // If order is fully inactive (no reservations and nothing remaining), close it and return rent to creator
    if ctx.accounts.order.reserved_amount == 0 && ctx.accounts.order.remaining_amount() == 0 {
        // Prepare seeds for vault close
        let bump = ctx.accounts.order.bump;
        let creator_pk = ctx.accounts.order.creator;
        let mint_pk = ctx.accounts.order.crypto_mint;
        let order_id_le = ctx.accounts.order.order_id.to_le_bytes();
        let seeds = &[
            b"universal_order",
            creator_pk.as_ref(),
            mint_pk.as_ref(),
            order_id_le.as_ref(),
            &[bump],
        ];
        let signer = &[&seeds[..]];

        // Close vault TokenAccount first to reclaim rent
        let close_vault_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.admin_rent_receiver.to_account_info(), // rent → admin
                authority: ctx.accounts.order.to_account_info(),
            },
            signer,
        );
        close_account(close_vault_ctx)?;

        // Then close order PDA to reclaim its rent (to admin)
        let admin_ai = ctx.accounts.admin_rent_receiver.to_account_info();
        ctx.accounts.order.close(admin_ai)?;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    // CHECK:
    #[account(mut)]
    pub creator: Signer<'info>,

    /// CHECK: Admin wallet receives rent back (hardcoded address)
    #[account(
        mut,
        address = crate::constants::ADMIN_PUBKEY @ UniversalOrderError::Unauthorized
    )]
    pub admin_rent_receiver: UncheckedAccount<'info>,

    /// Parent order PDA
    #[account(
        mut,
        seeds = [b"universal_order", order.creator.as_ref(), order.crypto_mint.as_ref(), order.order_id.to_le_bytes().as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, UniversalOrder>,

    /// Vault holding locked tokens for sell orders
    #[account(
        mut,
        seeds = [b"vault", order.key().as_ref()],
        bump,
        constraint = vault.mint == order.crypto_mint
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Creator's token account to receive refunds (sell orders only)
    #[account(mut)]
    pub creator_token_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}
