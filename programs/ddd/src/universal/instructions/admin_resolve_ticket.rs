use anchor_lang::prelude::*;
use anchor_lang::prelude::AccountsClose; // for account close
use anchor_spl::token::{Token, TokenAccount, Transfer, transfer};
use crate::universal::state::*;
use crate::universal::errors::UniversalOrderError;
use crate::universal::utils::fees::calculate_fee;
use crate::universal::utils::auto_close::auto_close_if_needed;
use crate::constants::ADMIN_PUBKEY;

/// Admin resolve for a specific ticket: either settle to FiatGuy or refund to CryptoGuy
pub fn admin_resolve_ticket(
    ctx: Context<AdminResolveTicket>,
    release_to_fiat_guy: bool,
) -> Result<()> {
    // Auth
    require_keys_eq!(ctx.accounts.admin.key(), ADMIN_PUBKEY, UniversalOrderError::Unauthorized);

    // Immutable snapshots to avoid borrow conflicts during CPI
    let order_key = ctx.accounts.order.key();
    let is_sell = ctx.accounts.order.is_sell_order;
    let order_creator = ctx.accounts.order.creator;
    let order_mint = ctx.accounts.order.crypto_mint;
    let order_id_le = ctx.accounts.order.order_id.to_le_bytes();
    let order_bump = ctx.accounts.order.bump;

    let ticket = &mut ctx.accounts.ticket;

    // CHECK: Ticket belongs to order
    require!(ticket.order == order_key, UniversalOrderError::Unauthorized);

    // Identify roles
    let crypto_guy = if is_sell { order_creator } else { ticket.acceptor };
    let fiat_guy   = if is_sell { ticket.acceptor } else { order_creator };

    let amount = ticket.amount;
    require!(amount > 0, UniversalOrderError::InvalidAmount);

    if release_to_fiat_guy {
        // Payout path: 99.8% to FiatGuy + 0.2% to Admin
        let fiat_ata = ctx.accounts.fiat_guy_token_account.as_ref()
            .ok_or(UniversalOrderError::TokenAccountRequired)?;
        require!(fiat_ata.mint == order_mint, UniversalOrderError::InvalidTokenAccount);
        require!(fiat_ata.owner == fiat_guy, UniversalOrderError::Unauthorized);

        // CHECK: Admin fee account provided
        let admin_fee_account = ctx.accounts.admin_fee_account.as_ref()
            .ok_or(UniversalOrderError::TokenAccountRequired)?;
        require!(admin_fee_account.mint == order_mint, UniversalOrderError::InvalidTokenAccount);
        require!(admin_fee_account.owner == ADMIN_PUBKEY, UniversalOrderError::Unauthorized);

        // Calculate 0.2% fee
        let (fee_amount, net_amount) = calculate_fee(amount)?;

        let seeds = &[
            b"universal_order",
            order_creator.as_ref(),
            order_mint.as_ref(),
            order_id_le.as_ref(),
            &[order_bump],
        ];
        let signer = &[&seeds[..]];

        // Transfer 1: 99.8% to FiatGuy
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: fiat_ata.to_account_info(),
                authority: ctx.accounts.order.to_account_info(),
            },
            signer,
        );
        transfer(cpi, net_amount)?;

        // Transfer 2: 0.2% to Admin (fee)
        let fee_cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: admin_fee_account.to_account_info(),
                authority: ctx.accounts.order.to_account_info(),
            },
            signer,
        );
        transfer(fee_cpi, fee_amount)?;

        {
            let order = &mut ctx.accounts.order;
            order.filled_amount = order.filled_amount.saturating_add(amount);
            order.reserved_amount = order.reserved_amount.saturating_sub(amount);
        }
        // Mark ticket as settled
        ticket.crypto_guy_signed = true;
        ticket.fiat_guy_signed = true;
        ticket.amount = 0;

        // Return rent to admin (who paid for ticket creation)
        let admin_info = ctx.accounts.admin_rent_receiver.to_account_info();
        ticket.close(admin_info)?;

        // AUTO-CLOSE: Check if order is fully completed (payout path)
        auto_close_if_needed(
            &mut ctx.accounts.order,
            &ctx.accounts.vault,
            &ctx.accounts.admin_rent_receiver.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            false, // is_refund = false (only close if completed)
        )?;
    } else {
        // Refund path
        if is_sell {
            // Refund to creator (CryptoGuy)
            let creator_ata = ctx.accounts.crypto_guy_token_account.as_ref()
                .ok_or(UniversalOrderError::TokenAccountRequired)?;
            require!(creator_ata.mint == order_mint, UniversalOrderError::InvalidTokenAccount);
            require!(creator_ata.owner == crypto_guy, UniversalOrderError::Unauthorized);

            let seeds = &[
                b"universal_order",
                order_creator.as_ref(),
                order_mint.as_ref(),
                order_id_le.as_ref(),
                &[order_bump],
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
            transfer(cpi, amount)?;
            // Reduce target to reflect refund out of the order
            {
                let order = &mut ctx.accounts.order;
                order.reserved_amount = order.reserved_amount.saturating_sub(amount);
                order.crypto_amount = order.crypto_amount.saturating_sub(amount);
            }
            // Ticket refunded/voided
            ticket.crypto_guy_signed = false;
            ticket.fiat_guy_signed = false;
            ticket.amount = 0;

            // Close ticket and return rent to admin
            let admin_info = ctx.accounts.admin_rent_receiver.to_account_info();
            ticket.close(admin_info)?;

            // AUTO-CLOSE: Refund means order is cancelled (always close)
            auto_close_if_needed(
                &mut ctx.accounts.order,
                &ctx.accounts.vault,
                &ctx.accounts.admin_rent_receiver.to_account_info(),
                &ctx.accounts.token_program.to_account_info(),
                true, // is_refund = true (always close)
            )?;
        } else {
            // Buy order: refund to ticket.acceptor (CryptoGuy)
            let acceptor_ata = ctx.accounts.crypto_guy_token_account.as_ref()
                .ok_or(UniversalOrderError::TokenAccountRequired)?;
            require!(acceptor_ata.mint == order_mint, UniversalOrderError::InvalidTokenAccount);
            require!(acceptor_ata.owner == crypto_guy, UniversalOrderError::Unauthorized);

            let seeds = &[
                b"universal_order",
                order_creator.as_ref(),
                order_mint.as_ref(),
                order_id_le.as_ref(),
                &[order_bump],
            ];
            let signer = &[&seeds[..]];

            let cpi = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: acceptor_ata.to_account_info(),
                    authority: ctx.accounts.order.to_account_info(),
                },
                signer,
            );
            transfer(cpi, amount)?;
            {
                let order = &mut ctx.accounts.order;
                order.reserved_amount = order.reserved_amount.saturating_sub(amount);
            }
            // Ticket refunded/voided
            ticket.crypto_guy_signed = false;
            ticket.fiat_guy_signed = false;
            ticket.amount = 0;

            // Close ticket and return rent to admin
            let admin_info = ctx.accounts.admin_rent_receiver.to_account_info();
            ticket.close(admin_info)?;

            // AUTO-CLOSE: Refund means order is cancelled (always close)
            auto_close_if_needed(
                &mut ctx.accounts.order,
                &ctx.accounts.vault,
                &ctx.accounts.admin_rent_receiver.to_account_info(),
                &ctx.accounts.token_program.to_account_info(),
                true, // is_refund = true (always close)
            )?;
        }
    }

    Ok(())
}

#[derive(Accounts)]
pub struct AdminResolveTicket<'info> {
    /// Admin signer must match ADMIN_PUBKEY
    #[account(mut, signer)]
    /// CHECK: compared to constant
    pub admin: AccountInfo<'info>,

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

    /// Vault PDA
    #[account(
        mut,
        seeds = [b"vault", order.key().as_ref()],
        bump,
        constraint = vault.mint == order.crypto_mint
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Ticket PDA to resolve
    #[account(
        mut,
        seeds = [b"ticket", order.key().as_ref(), ticket.ticket_id.to_le_bytes().as_ref()],
        bump = ticket.bump
    )]
    pub ticket: Account<'info, FillTicket>,

    /// Optional ATAs for the payout/refund direction
    #[account(mut)]
    pub fiat_guy_token_account: Option<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub crypto_guy_token_account: Option<Account<'info, TokenAccount>>,

    /// Admin's token account (for 0.2% fee on payouts only)
    #[account(mut)]
    pub admin_fee_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}
