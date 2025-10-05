use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Transfer, transfer};
use crate::universal::state::*;
use crate::universal::errors::UniversalOrderError;
use crate::constants::ADMIN_PUBKEY;

/// Admin resolve for Universal Order (order-level)
/// Use cases:
/// - Sell order: release unreserved amount from vault to destination ATA
/// - Buy order: no on-chain funds to move; can only mark cancelled by shrinking target to filled
pub fn admin_resolve_order(
    ctx: Context<AdminResolveOrder>,
    amount: u64,
) -> Result<()> {
    // Immutable view + snapshots to avoid borrow conflicts
    let order_acc = &ctx.accounts.order;
    let is_sell = order_acc.is_sell_order;
    let creator_pk = order_acc.creator;
    let mint_pk = order_acc.crypto_mint;
    let order_id_le = order_acc.order_id.to_le_bytes();
    let bump = order_acc.bump;

    // Authorization: Only ADMIN_PUBKEY
    require_keys_eq!(ctx.accounts.admin.key(), ADMIN_PUBKEY, UniversalOrderError::Unauthorized);

    // Remaining available (non-filled) amount
    let remaining = order_acc.remaining_amount();
    require!(remaining > 0, UniversalOrderError::OrderCompleted);

    if is_sell {
        // Admin can only move tokens not reserved by active tickets
        let releasable = remaining.saturating_sub(order_acc.reserved_amount);
        require!(releasable > 0, UniversalOrderError::CannotCancel);
        require!(amount <= releasable, UniversalOrderError::InvalidAmount);

    // Validate destination ATA mint matches and belongs to the creator (seller)
    require!(ctx.accounts.destination_ata.mint == mint_pk, UniversalOrderError::InvalidTokenAccount);
    require!(ctx.accounts.destination_ata.owner == creator_pk, UniversalOrderError::Unauthorized);

        // Order PDA is the vault authority
        let signer_seeds = &[
            b"universal_order",
            creator_pk.as_ref(),
            mint_pk.as_ref(),
            order_id_le.as_ref(),
            &[bump],
        ];
        let signer = &[&signer_seeds[..]];

        // Transfer from vault to destination
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.destination_ata.to_account_info(),
                authority: ctx.accounts.order.to_account_info(),
            },
            signer,
        );
        transfer(cpi, amount)?;

        // Reduce target so remaining reflects admin release
        // Effectively: crypto_amount = filled + reserved + leftover_after_release
        let releasable_after = releasable.saturating_sub(amount);
        {
            let order = &mut ctx.accounts.order;
            order.crypto_amount = order.filled_amount
                .saturating_add(order.reserved_amount)
                .saturating_add(releasable_after);
            if order.reserved_amount == 0 && order.remaining_amount() == 0 {
                order.status = OrderStatus::Cancelled;
            }
        }
    } else {
        // Buy order: nothing in vault owned by order creator. Admin can only finalize/cancel bookkeeping
        // Here we support amount == 0 as a no-op but allow marking as Cancelled if no active tickets
        require!(order_acc.reserved_amount == 0, UniversalOrderError::CannotCancel);
        let filled = order_acc.filled_amount;
        {
            let order = &mut ctx.accounts.order;
            order.crypto_amount = filled;
            order.status = OrderStatus::Cancelled;
        }
    }

    Ok(())
}

#[derive(Accounts)]
pub struct AdminResolveOrder<'info> {
    /// Admin signer must match ADMIN_PUBKEY
    #[account(signer)]
    /// CHECK: compared to constant
    pub admin: AccountInfo<'info>,

    /// Parent order PDA
    #[account(
        mut,
        seeds = [b"universal_order", order.creator.as_ref(), order.crypto_mint.as_ref(), order.order_id.to_le_bytes().as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, UniversalOrder>,

    /// Vault PDA
    #[account(
        mut,
        seeds = [b"vault", order.key().as_ref()],
        bump,
        constraint = vault.mint == order.crypto_mint
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Destination ATA (must match order.crypto_mint)
    #[account(mut)]
    pub destination_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}
