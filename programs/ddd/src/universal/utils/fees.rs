use anchor_lang::prelude::*;

pub const FEE_BASIS_POINTS: u64 = 20;

pub fn calculate_fee(total: u64) -> Result<(u64, u64)> {
    let fee = total
        .checked_mul(FEE_BASIS_POINTS)
        .ok_or(ProgramError::ArithmeticOverflow)?
        .checked_div(10_000)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    
    let net = total
        .checked_sub(fee)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    
    Ok((fee, net))
}