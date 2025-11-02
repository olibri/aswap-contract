use anchor_lang::prelude::*;
use anchor_lang::prelude::AccountsClose;
use anchor_spl::token::{TokenAccount, CloseAccount, close_account};
use crate::universal::state::*;

/// Auto-close vault and order if conditions are met
/// Returns rent to admin_rent_receiver
/// 
/// For payout: closes only if order is fully completed (remaining=0, reserved=0)
/// For refund: closes always (order is cancelled)
pub fn auto_close_if_needed<'info>(
    order: &mut Account<'info, UniversalOrder>,
    vault: &Account<'info, TokenAccount>,
    admin_rent_receiver: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    is_refund: bool, // true = always close, false = close only if completed
) -> Result<()> {
    let should_close = if is_refund {
        // Refund = order cancelled, always close
        msg!("Auto-close check: is_refund=true, will close");
        true
    } else {
        // Payout = check if order fully completed
        let remaining = order.remaining_amount();
        let will_close = remaining == 0 && order.reserved_amount == 0;
        msg!("Auto-close check: remaining={}, reserved={}, will_close={}", remaining, order.reserved_amount, will_close);
        will_close
    };

    if !should_close {
        msg!("Auto-close skipped: conditions not met");
        return Ok(());
    }

    msg!("Auto-closing vault and order, returning rent to admin.");

    // Close vault if empty
    let vault_balance = vault.amount;
    if vault_balance == 0 {
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
            account: vault.to_account_info(),
            destination: admin_rent_receiver.clone(),
            authority: order.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            token_program.clone(),
            close_vault_accounts,
            signer,
        );

        close_account(cpi_ctx)?;
        msg!("Vault closed, rent returned to admin");

        // Close order account and return rent to admin (only after vault is closed)
        order.close(admin_rent_receiver.clone())?;
        msg!("Order closed, rent returned to admin");
    } else {
        msg!("Warning: Vault still has {} tokens, cannot close yet", vault_balance);
    }

    Ok(())
}
