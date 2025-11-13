use anchor_lang::prelude::*;
use anchor_lang::prelude::AccountsClose; // for conditional account close
use anchor_spl::token_interface::{TokenAccount, TokenInterface, Mint, transfer_checked, TransferChecked, close_account, CloseAccount};
use crate::universal::state::*;
use crate::universal::errors::UniversalOrderError;
use crate::universal::utils::fees::calculate_fee;

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

        // Calculate 0.25% fee
        let (fee_amount, net_amount) = calculate_fee(amount)?;
        
        // Get mint decimals for transfer_checked
        let decimals = ctx.accounts.mint.decimals;

        // Prepare PDA signer: the vault's owner is the order PDA
        let order_signer_seeds = &[
            b"universal_order",
            order_creator.as_ref(),
            order_mint.as_ref(),
            order_id_le.as_ref(),
            &[order_bump],
        ];
        let order_signer = &[&order_signer_seeds[..]];

        // Transfer 1: 99.75% to FiatGuy
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                to: fiat_guy_token_account.to_account_info(),
                authority: ctx.accounts.order.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
            },
            order_signer,
        );
        transfer_checked(transfer_ctx, net_amount, decimals)?;

        // Transfer 2: 0.25% to Admin (fee)
        let fee_transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                to: admin_fee_account.to_account_info(),
                authority: ctx.accounts.order.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
            },
            order_signer,
        );
        transfer_checked(fee_transfer_ctx, fee_amount, decimals)?;

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

        // Read vault balance directly from account data (after transfers completed)
        let vault_account = ctx.accounts.vault.to_account_info();
        let vault_data = vault_account.try_borrow_data()?;
        let vault_balance = u64::from_le_bytes(vault_data[64..72].try_into().unwrap());
        drop(vault_data); // Release borrow
        msg!("Vault balance after transfers: {}", vault_balance);

        // AUTO-CLOSE order if fully completed (pass vault balance directly)
        if vault_balance == 0 {
            let order = &ctx.accounts.order;
            let remaining = order.remaining_amount();
            let should_close = remaining == 0 && order.reserved_amount == 0;
            
            if should_close {
                msg!("Auto-closing vault and order, returning rent to admin.");
                
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

                // Close the ticket account returning rent to admin (LAST!)
                ticket.close(ctx.accounts.admin_rent_receiver.to_account_info())?;
                msg!("Ticket closed, rent returned to admin");
                
                return Ok(());
            }
        }

        // If vault not empty or order not completed, just close ticket
        ticket.close(ctx.accounts.admin_rent_receiver.to_account_info())?;
        
        // If not closed, continue to update timestamp
        return Ok(());
    }

    // If NOT both signed yet, update order timestamp
    let order = &mut ctx.accounts.order;
    order.updated_at = clock.unix_timestamp;

    Ok(())
}

#[derive(Accounts)]
pub struct SignTicket<'info> {
    /// Admin pays transaction fee (first signer = pays transaction fee)
    #[account(
        mut,
        address = crate::constants::ADMIN_PUBKEY @ UniversalOrderError::Unauthorized
    )]
    pub fee_payer: Signer<'info>,

    /// User who signs the ticket (second signer)
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
    
    /// Mint account - needed for transfer_checked
    pub mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Vault PDA - supports both SPL Token and Token-2022
    #[account(
        mut,
        seeds = [b"vault", order.key().as_ref()],
        bump,
        constraint = vault.mint == order.crypto_mint @ UniversalOrderError::InvalidTokenAccount,
        constraint = vault.mint == mint.key() @ UniversalOrderError::InvalidTokenAccount
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Ticket PDA
    #[account(
        mut,
        seeds = [b"ticket", order.key().as_ref(), ticket.ticket_id.to_le_bytes().as_ref()],
        bump = ticket.bump
    )]
    pub ticket: Account<'info, FillTicket>,

    // FiatGuy's token account (where crypto will be sent)
    #[account(mut)]
    pub fiat_guy_token_account: Option<InterfaceAccount<'info, TokenAccount>>,

    // Admin's token account (for 0.25% fee)
    #[account(mut)]
    pub admin_fee_account: Option<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}
