use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Неправильний баєр")]
    InvalidBuyer,
    #[msg("Неправильний селлер")]
    InvalidSeller,
    #[msg("Ця пропозиція вже має баєра")]
    AlreadyClaimed,
    #[msg("Ця пропозиція вже скасована")]
    AlreadyCanceled,
    #[msg("Ця пропозиція вже підписана")]
    AlreadySigned,
    #[msg("Не можна скасувати")]
    CannotCancel,
    #[msg("Not enough remaining amount in offer")]
    InsufficientRemaining,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Timeout not reached yet")]
    TimeoutNotReached,
    #[msg("Nothing to return")]
    NothingToReturn,
    #[msg("Invalid offer in cancel partial")]
    InvalidOffer,
    #[msg("Buyer must sign fist")]
    BuyerMustSignFirst,
    #[msg("Only the hard-coded admin may call this instruction")]
    UnauthorizedAdmin,
    #[msg("Destination ATA must belong to buyer or seller")]
    InvalidDestination,
    #[msg("Amount exceeds remaining locked balance")]
    AmountExceedsRemaining,
    #[msg("Destination mint does not match escrow mint")]
    MintMismatch,
    #[msg("Invalid buy order amount")]
    InvalidBuyOrderAmount,
    #[msg("Insufficient buy order remaining")]
    InsufficientBuyOrderRemaining,
    #[msg("Cannot cancel buy order with active fills")]
    CannotCancelWithActiveFills,
    #[msg("Only buyer can cancel buy order")]
    OnlyBuyerCanCancelBuyOrder,
    #[msg("Cannot cancel after buyer signed")]
    CannotCancelAfterBuyerSigned,
    #[msg("Offer amount too small")]
    OfferTooSmall,
    #[msg("Fill amount too small")]
    FillTooSmall,
    #[msg("Unauthorized seller - account does not match escrow seller")]
    UnauthorizedSeller,
    #[msg("Unauthorized buyer - account does not match escrow buyer")]
    UnauthorizedBuyer,
    #[msg("Too many fills per day")]
    TooManyFillsPerDay,
    #[msg("Action too frequent, please wait")]
    ActionTooFrequent,
    #[msg("Too many active offers")]
    TooManyActiveOffers,
}
