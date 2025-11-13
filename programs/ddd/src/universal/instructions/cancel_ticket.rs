use anchor_lang::prelude::*;
use anchor_lang::prelude::AccountsClose;
use anchor_spl::token_interface::{TokenAccount, TokenInterface, Mint, transfer_checked, TransferChecked, close_account, CloseAccount};
use crate::universal::state::*;
use crate::universal::errors::UniversalOrderError;

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
    
    // Get mint decimals
    let decimals = ctx.accounts.mint.decimals;

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
        TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            to: crypto_guy_ata.to_account_info(),
            authority: ctx.accounts.order.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
        },
        signer,
    );
    transfer_checked(transfer_ctx, ticket.amount, decimals)?;

    // Emit cancellation event
    emit!(crate::universal::events::TicketCancelled {
        order: order_key,
        ticket: ticket.key(),
        canceller: canceller.key(),
        amount: ticket.amount,
        refunded: true,
        timestamp: clock.unix_timestamp,
    });

    // Read vault balance directly after transfer
    let vault_account = ctx.accounts.vault.to_account_info();
    let vault_data = vault_account.try_borrow_data()?;
    let vault_balance = u64::from_le_bytes(vault_data[64..72].try_into().unwrap());
    drop(vault_data);

    // AUTO-CLOSE: Cancel means order is cancelled, close if vault is empty
    if vault_balance == 0 {
        let order = &ctx.accounts.order;
        msg!("Auto-closing vault and order after cancel, returning rent to admin.");
        
        let order_creator = order.creator;
        let order_mint = order.crypto_mint;
        let order_id_le = order.order_id.to_le_bytes();
        let order_bump = order.bump;

        let seeds = &[
            b"universal_order".as_ref(),
            order_creator.as_ref(),
            order_mint.as_ref(),
            order_id_le.as_ref(),
            &[order_bump],
        ];
        let signer = &[&seeds[..]];

        let close_vault_accounts = CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.admin_rent_receiver.to_account_info(),
            authority: ctx.accounts.order.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            close_vault_accounts,
            signer,
        );

        close_account(cpi_ctx)?;
        msg!("Vault closed, rent returned to admin");

        // Close order account and return rent to admin
        ctx.accounts.order.close(ctx.accounts.admin_rent_receiver.to_account_info())?;
        msg!("Order closed, rent returned to admin");

        // Close ticket last
        ticket.close(ctx.accounts.admin_rent_receiver.to_account_info())?;
        msg!("Ticket closed, rent returned to admin");
    } else {
        // If vault not empty, just close ticket
        ticket.close(ctx.accounts.admin_rent_receiver.to_account_info())?;
    }

    Ok(())
}

#[derive(Accounts)]
pub struct CancelTicket<'info> {
    /// Admin pays transaction fee (first signer = pays transaction fee)
    #[account(
        mut,
        address = crate::constants::ADMIN_PUBKEY @ UniversalOrderError::Unauthorized
    )]
    pub fee_payer: Signer<'info>,

    /// FiatGuy who cancels (second signer)
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
    
    /// Mint account - needed for transfer_checked
    pub mint: InterfaceAccount<'info, Mint>,

    /// Vault (will be closed after refund) - supports both SPL Token and Token-2022
    #[account(
        mut,
        seeds = [b"vault", order.key().as_ref()],
        bump,
        constraint = vault.mint == order.crypto_mint @ UniversalOrderError::InvalidTokenAccount,
        constraint = vault.mint == mint.key() @ UniversalOrderError::InvalidTokenAccount
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// Ticket to cancel (will be closed)
    #[account(
        mut,
        seeds = [b"ticket", order.key().as_ref(), ticket.ticket_id.to_le_bytes().as_ref()],
        bump = ticket.bump
    )]
    pub ticket: Account<'info, FillTicket>,

    /// CryptoGuy's token account (receives refund)
    #[account(mut)]
    pub crypto_guy_token_account: Option<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}
