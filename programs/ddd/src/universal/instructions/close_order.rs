use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Transfer, transfer, CloseAccount, close_account};
use crate::universal::state::*;
use crate::universal::errors::UniversalOrderError;
use crate::constants::ORDER_CLOSE_DUST;

/// Close Universal Order account to reclaim rent once it's effectively finished
/// Conditions:
/// - reserved_amount == 0 (no active tickets)
/// - remaining_amount() <= ORDER_CLOSE_DUST (treat tiny remainder as dust)
/// - For Sell orders: move remaining (if any) from vault back to creator ATA before close
pub fn close_order(ctx: Context<CloseOrder>) -> Result<()> {
    let closer = &ctx.accounts.closer;
    let order = &ctx.accounts.order;

    // Only creator or admin can close (admin pays rent, so should be able to reclaim it)
    require!(
        closer.key() == order.creator || closer.key() == crate::constants::ADMIN_PUBKEY, 
        UniversalOrderError::Unauthorized
    );

    // No active reservations
    require!(order.reserved_amount == 0, UniversalOrderError::CannotCancel);

    let remaining = order.remaining_amount();
    require!(remaining <= ORDER_CLOSE_DUST, UniversalOrderError::CannotCancel);

    // For Sell order, return any tiny remainder from vault
    if order.is_sell_order && remaining > 0 {
        let creator_ata = ctx.accounts.creator_token_account.as_ref()
            .ok_or(UniversalOrderError::TokenAccountRequired)?;
        require!(creator_ata.mint == order.crypto_mint, UniversalOrderError::InvalidTokenAccount);
        require!(creator_ata.owner == order.creator, UniversalOrderError::Unauthorized);

        // Order PDA is the vault's authority
        let bump = order.bump;
        let creator_pk = order.creator;
        let mint_pk = order.crypto_mint;
        let order_id_le = order.order_id.to_le_bytes();
        let seeds = &[
            b"universal_order",
            creator_pk.as_ref(),
            mint_pk.as_ref(),
            order_id_le.as_ref(),
            &[bump],
        ];
        let signer = &[&seeds[..]];

        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: creator_ata.to_account_info(),
                authority: ctx.accounts.order.to_account_info(),
            },
            signer,
        );
        transfer(cpi, remaining)?;
    }

    // Prepare seeds for vault close (reuse from transfer if Sell, or create fresh)
    let bump = order.bump;
    let creator_pk = order.creator;
    let mint_pk = order.crypto_mint;
    let order_id_le = order.order_id.to_le_bytes();
    let seeds = &[
        b"universal_order",
        creator_pk.as_ref(),
        mint_pk.as_ref(),
        order_id_le.as_ref(),
        &[bump],
    ];
    let signer = &[&seeds[..]];

    // Close vault TokenAccount to reclaim rent; vault must be empty (amount = 0)
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

    // Emit close event
    emit!(crate::universal::events::OrderClosed {
        order: order.key(),
        creator: order.creator,
        dust_amount: remaining,
        rent_returned_to: closer.key(),
        timestamp: Clock::get()?.unix_timestamp,
    });

    // Mark cancelled for clarity (optional)
    // After this, the order account will be closed by Anchor attribute in Accounts
    Ok(())
}

#[derive(Accounts)]
pub struct CloseOrder<'info> {
    /// The creator or admin who closes the order
    #[account(mut)]
    pub closer: Signer<'info>,

    /// CHECK: Admin wallet receives rent back (hardcoded address)
    #[account(
        mut,
        address = crate::constants::ADMIN_PUBKEY @ UniversalOrderError::Unauthorized
    )]
    pub admin_rent_receiver: UncheckedAccount<'info>,

    /// The order to close; send lamports (rent) to admin
    #[account(
        mut,
        close = admin_rent_receiver,
        seeds = [b"universal_order", order.creator.as_ref(), order.crypto_mint.as_ref(), order.order_id.to_le_bytes().as_ref()],
        bump = order.bump
    )]
    pub order: Account<'info, UniversalOrder>,

    /// Order vault PDA for potential remainder transfer (sell orders)
    #[account(
        mut,
        seeds = [b"vault", order.key().as_ref()],
        bump,
        constraint = vault.mint == order.crypto_mint
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Creator ATA (sell orders only)
    #[account(mut)]
    pub creator_token_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}
