# Universal Orders API (Frontend Developer Guide)

This is a complete reference for the Universal Orders system under `programs/ddd/src/universal`. It covers all methods, parameters, when to use them, and provides TypeScript examples.

## Overview

The Universal Orders system sup### 4. cancelTicket()

**Purpose**: Cancel a ticket before both parties have signed

**Parameters**: None (ticket identified by context)

**When to use**:
- Either order creator OR ticket acceptor wants to cancel
- **Only allowed BEFORE FiatGuy signs** (once fiat confir### 8. adminResolveOrder(amount)

**Purpose**: Admin order-level resolution (prefer ticket-level when possible)

**Parameters**:
- `amount: u64` - Amount to resolve at order level

**When to use**:
- Order-level disputes or cleanup
- **Prefer `adminResolveTicket` for specific ticket disputes**
- **Only callable by hardcoded ADMIN_PUBKEY**

**Required accounts**:
```ts
{
  admin: Signer,                       // Must match ADMIN_PUBKEY constant
  order: Account,                      // Order PDA to resolve
  vault: Account,                      // Order's token vault
  destinationAta: Account,             // Where to send tokens (validated)
  tokenProgram: PublicKey,
}
```

**Behavior**:

**Sell Orders**:
- Can move unreserved portion from vault to destination ATA
- Must be ≤ `remaining_amount - reserved_amount`
- Shrinks `crypto_amount` accordingly
- Destination must be creator's ATA (validated)

**Buy Orders**:
- No on-chain tokens to move
- Can only mark as cancelled when no active tickets
- Sets `crypto_amount = filled_amount`

**TypeScript Example (Sell Order)**:
```ts
const resolveAmount = new anchor.BN(50_000_000); // 50 tokens

await program.methods
  .adminResolveOrder(resolveAmount)
  .accounts({
    admin: adminKeypair.publicKey,
    order: orderPda,
    vault: vaultPda,
    destinationAta: sellerTokenAccount,  // Must be order creator's ATA
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([adminKeypair])
  .rpc();
``` cancel)

**Required accounts**:
```ts
{
  canceller: Signer,                   // order.creator OR ticket.acceptor
  order: Account,                      // Parent order PDA
  vault: Account,                      // Order's token vault
  ticket: Account,                     // Ticket to cancel (will be closed)
  acceptorTokenAccount?: Account,      // Required for Buy order refunds
  tokenProgram: PublicKey,
}
```

**Rules**:
- `ticket.fiat_guy_signed` must be false
- Canceller must be order creator OR ticket acceptor
- **Buy orders**: Refunds locked tokens back to acceptor
- **Sell orders**: No refund needed (tokens stay in vault)

**Behavior**:
- Updates `order.reserved_amount -= ticket.amount`
- **Buy orders**: Transfers `ticket.amount` from vault back to acceptor
- Closes ticket account (rent returned to canceller)
- Emits `TicketCancelled` event

**TypeScript Example (Sell order)**:
```ts
await program.methods
  .cancelTicket()
  .accounts({
    canceller: buyer.publicKey,     // Acceptor cancelling
    order: orderPda,
    vault: vaultPda,
    ticket: ticketPda,
    acceptorTokenAccount: null,     // Sell order: no refund needed
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([buyer])
  .rpc();
```

**TypeScript Example (Buy order)**:
```ts
await program.methods
  .cancelTicket()
  .accounts({
    canceller: seller.publicKey,        // Acceptor cancelling
    order: orderPda,
    vault: vaultPda,
    ticket: ticketPda,
    acceptorTokenAccount: sellerTokenAccount,  // Buy order: refund to acceptor
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([seller])
  .rpc();
```Sell** and **Buy** orders with parallel partial fills:
- **Sell Order**: CryptoGuy creates order and locks tokens immediately, FiatGuy accepts and fills
- **Buy Order**: FiatGuy creates order without locking, CryptoGuy accepts and locks tokens per fill
- **Partial Fills**: Multiple "tickets" can fill one order in parallel
- **Fiat-First Rule**: FiatGuy must sign before CryptoGuy on each ticket

## Key Concepts

### PDAs (Program Derived Addresses)
- **Order PDA**: `["universal_order", creator, mint, orderIdLE]` - Main order account
- **Vault PDA**: `["vault", orderPda]` - Token vault owned by order PDA
- **Ticket PDA**: `["ticket", orderPda, ticketIdLE]` - Individual partial fill

### Order Lifecycle
1. **Created** → Order exists, waiting for first acceptor
2. **Accepted** → Someone created a ticket (partial fill)
3. **BothSigned** → Both parties signed a ticket (transitional)
4. **Completed** → Order fully filled
5. **Cancelled** → Order cancelled by creator or admin

### Amounts (all u64 in token's smallest unit)
- `crypto_amount`: Target amount to trade
- `filled_amount`: Already completed amount  
- `reserved_amount`: Sum of active tickets awaiting signatures
- Available for new tickets: `crypto_amount - filled_amount - reserved_amount`

## Methodsders API (frontend)

This doc summarizes the on-chain API for universal orders under `programs/ddd/src/universal`. It shows what to call from the Anchor client, required accounts, signer rules, and common errors.

Note: All amounts are in the token mint's smallest unit (e.g., 6 decimals → 1 USDC = 1_000_000).

## PDAs
- Order PDA: ["universal_order", creator, mint, orderIdLE]
- Vault PDA: ["vault", orderPda]
- Ticket PDA: ["ticket", orderPda, ticketIdLE]

You don’t create PDAs manually; pass the derived addresses to `.accounts()`.

## Instructions

### 1. createOrder(orderId, cryptoAmount, fiatAmount, isSellOrder)

**Purpose**: Create a new universal order (Sell or Buy type)

**Parameters**:
- `orderId: u64` - Unique business identifier (timestamp or counter)
- `cryptoAmount: u64` - Total crypto tokens to trade (in token's smallest unit)
- `fiatAmount: u64` - Reference fiat amount (off-chain, for display)
- `isSellOrder: bool` - true = Sell order (CryptoGuy creates), false = Buy order (FiatGuy creates)

**When to use**:
- CryptoGuy wants to sell tokens (isSellOrder=true)
- FiatGuy wants to buy tokens (isSellOrder=false)

**Required accounts**:
```ts
{
  creator: Signer,                    // Order creator
  order: Account,                     // PDA: ["universal_order", creator, mint, orderId]
  mint: Account,                      // SPL token mint
  vault: Account,                     // PDA: ["vault", order] 
  creatorTokenAccount?: Account,      // Required for Sell orders only
  tokenProgram: PublicKey,
  systemProgram: PublicKey,
}
```

**Behavior**:
- **Sell order**: Immediately transfers full `cryptoAmount` from creator to vault
- **Buy order**: No token transfer, just creates order
- Emits `UniversalOrderCreated` event

**TypeScript Example (Sell Order)**:
```ts
const orderId = new anchor.BN(Date.now());
const cryptoAmount = new anchor.BN(100_000_000); // 100 USDC (6 decimals)
const fiatAmount = new anchor.BN(100_00);        // $100.00 (2 decimals)

const [orderPda] = PublicKey.findProgramAddressSync([
  Buffer.from("universal_order"),
  seller.publicKey.toBuffer(),
  mint.toBuffer(),
  orderId.toArrayLike(Buffer, "le", 8),
], program.programId);

const [vaultPda] = PublicKey.findProgramAddressSync([
  Buffer.from("vault"),
  orderPda.toBuffer(),
], program.programId);

await program.methods
  .createOrder(orderId, cryptoAmount, fiatAmount, true)
  .accounts({
    creator: seller.publicKey,
    order: orderPda,
    mint,
    vault: vaultPda,
    creatorTokenAccount: sellerTokenAccount,  // Required for Sell
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .signers([seller])
  .rpc();
```

**TypeScript Example (Buy Order)**:
```ts
await program.methods
  .createOrder(orderId, cryptoAmount, fiatAmount, false)
  .accounts({
    creator: buyer.publicKey,
    order: orderPda,
    mint,
    vault: vaultPda,
    creatorTokenAccount: null,  // Not required for Buy
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .signers([buyer])
  .rpc();
```

### 2. acceptTicket(ticketId, amount)

**Purpose**: Accept a partial fill by creating a "ticket" that reserves amount on the order

**Parameters**:
- `ticketId: u64` - Unique identifier for this ticket (avoid collisions)
- `amount: u64` - Amount to reserve/fill (in token's smallest unit)

**When to use**:
- Someone wants to partially fill an existing order
- Must not be the order creator (opposite party only)

**Required accounts**:
```ts
{
  acceptor: Signer,                    // Person accepting the fill
  order: Account,                      // Parent order PDA
  vault: Account,                      // Order's token vault
  ticket: Account,                     // New ticket PDA: ["ticket", order, ticketId]
  acceptorTokenAccount?: Account,      // Required for Buy orders only
  tokenProgram: PublicKey,
  systemProgram: PublicKey,
}
```

**Rules & Limits**:
- `amount <= available_amount()` (not over-subscribe)
- Rate limiting: 5 second cooldown + daily cap
- **Buy orders**: acceptor (CryptoGuy) must provide tokens immediately
- **Sell orders**: tokens already in vault, just reserve amount

**Behavior**:
- Creates ticket PDA with amount reserved
- Updates `order.reserved_amount += amount`
- **Buy orders**: Transfers `amount` from acceptor to vault
- Emits `TicketAccepted` event

**TypeScript Example**:
```ts
const ticketId = new anchor.BN(1);
const fillAmount = new anchor.BN(25_000_000); // 25 USDC

const [ticketPda] = PublicKey.findProgramAddressSync([
  Buffer.from("ticket"),
  orderPda.toBuffer(),
  ticketId.toArrayLike(Buffer, "le", 8),
], program.programId);

// For Sell order (acceptor = FiatGuy, no token account needed)
await program.methods
  .acceptTicket(ticketId, fillAmount)
  .accounts({
    acceptor: buyer.publicKey,
    order: orderPda,
    vault: vaultPda,
    ticket: ticketPda,
    acceptorTokenAccount: null,  // Sell order: no tokens from acceptor
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .signers([buyer])
  .rpc();

// For Buy order (acceptor = CryptoGuy, must provide token account)
await program.methods
  .acceptTicket(ticketId, fillAmount)
  .accounts({
    acceptor: seller.publicKey,
    order: orderPda,
    vault: vaultPda,
    ticket: ticketPda,
    acceptorTokenAccount: sellerTokenAccount,  // Buy order: tokens from acceptor
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .signers([seller])
  .rpc();
```

### 3. signTicket()

**Purpose**: Sign a specific ticket to confirm your part of the trade

**Parameters**: None (ticket identified by context)

**When to use**:
- FiatGuy: Confirms they sent/will send fiat payment
- CryptoGuy: Confirms they received fiat and release crypto (must sign AFTER FiatGuy)

**Required accounts**:
```ts
{
  signer: Signer,                      // CryptoGuy or FiatGuy
  order: Account,                      // Parent order PDA
  vault: Account,                      // Order's token vault  
  ticket: Account,                     // Ticket to sign
  fiatGuyTokenAccount?: Account,       // Required if both will sign (for settlement)
  tokenProgram: PublicKey,
}
```

**Critical Rule - Fiat First**:
- **FiatGuy MUST sign first** (confirms fiat payment sent)
- **CryptoGuy signs second** (confirms fiat received, releases crypto)
- If CryptoGuy tries to sign first → `SignatureRequired` error

**Behavior**:
- Sets appropriate signature flag on ticket
- **When both signed**: Immediately settles the ticket:
  - Transfers `ticket.amount` from vault to FiatGuy's token account
  - Updates `order.filled_amount += amount`
  - Updates `order.reserved_amount -= amount`
  - Emits `TicketSigned` and `TicketSettled` events

**TypeScript Example (FiatGuy signs first)**:
```ts
// Step 1: FiatGuy confirms fiat payment
await program.methods
  .signTicket()
  .accounts({
    signer: buyer.publicKey,  // FiatGuy
    order: orderPda,
    vault: vaultPda,
    ticket: ticketPda,
    fiatGuyTokenAccount: buyerTokenAccount,  // Where crypto will go
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([buyer])
  .rpc();
```

**TypeScript Example (CryptoGuy signs second)**:
```ts
// Step 2: CryptoGuy confirms fiat received, releases crypto
await program.methods
  .signTicket()
  .accounts({
    signer: seller.publicKey,  // CryptoGuy  
    order: orderPda,
    vault: vaultPda,
    ticket: ticketPda,
    fiatGuyTokenAccount: buyerTokenAccount,  // Settlement destination
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([seller])
  .rpc();
// After this call, tokens are transferred to buyer, ticket settled
```

### 4) cancelTicket()
- Cancels a ticket by creator or acceptor, provided FiatGuy has not signed.
- Accounts:
  - canceller: Signer (order.creator or ticket.acceptor)
  - order: PDA
  - vault: PDA
  - ticket: PDA (close = canceller)
  - acceptorTokenAccount: Option<TokenAccount>
    - For buy orders, refund path requires acceptor’s ATA
  - tokenProgram
- Behavior:
  - If buy order, refunds ticket.amount from vault to acceptor ATA.
  - order.reserved_amount -= amount. Emits TicketCancelled.

### 5. cancelOrder()

**Purpose**: Cancel the entire order (or unreserved portion)

**Parameters**: None

**When to use**:
- Order creator wants to cancel their order
- **Sell orders**: Cancel unreserved portion (active tickets continue)
- **Buy orders**: Cancel only when no active tickets exist

**Required accounts**:
```ts
{
  creator: Signer,                     // Must be order.creator
  order: Account,                      // Order PDA to cancel
  vault: Account,                      // Order's token vault
  creatorTokenAccount?: Account,       // Required for Sell order refunds
  tokenProgram: PublicKey,
}
```

**Rules & Behavior**:

**Sell Orders**:
- Can cancel unreserved portion: `remaining_amount - reserved_amount`
- Returns unreserved tokens from vault to creator
- Shrinks `crypto_amount` to `filled_amount + reserved_amount`
- If no active tickets remain → status becomes `Cancelled`
- If active tickets exist → order stays open for those tickets

**Buy Orders**:
- Can only cancel when `reserved_amount == 0` (no active tickets)
- No tokens to return (nothing was locked on-chain)
- Sets `crypto_amount = filled_amount` and status = `Cancelled`

**TypeScript Example (Sell Order)**:
```ts
await program.methods
  .cancelOrder()
  .accounts({
    creator: seller.publicKey,
    order: orderPda,
    vault: vaultPda,
    creatorTokenAccount: sellerTokenAccount,  // Receive refund
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([seller])
  .rpc();
```

**TypeScript Example (Buy Order)**:
```ts
await program.methods
  .cancelOrder()
  .accounts({
    creator: buyer.publicKey,
    order: orderPda,
    vault: vaultPda,
    creatorTokenAccount: null,  // Buy order: no tokens to refund
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([buyer])
  .rpc();
```

### 6. closeOrder()

**Purpose**: Close the order account permanently and reclaim rent

**Parameters**: None

**When to use**:
- Order is effectively finished (filled or cancelled)
- Want to recover rent lamports from the order account

**Required accounts**:
```ts
{
  closer: Signer,                      // Must be order.creator
  order: Account,                      // Order PDA to close (rent returned)
  vault: Account,                      // Order's token vault
  creatorTokenAccount?: Account,       // For dust return (Sell orders)
  tokenProgram: PublicKey,
}
```

**Strict Conditions**:
- `order.reserved_amount == 0` (no active tickets)
- `remaining_amount() <= ORDER_CLOSE_DUST` (≤ 1 token dust)
- Only creator can close their own order

**Behavior**:
- **Sell orders**: Returns any tiny remainder (dust) from vault to creator
- **Buy orders**: No tokens to return
- Closes order account, rent lamports go to closer
- Emits `OrderClosed` event

**TypeScript Example**:
```ts
await program.methods
  .closeOrder()
  .accounts({
    closer: creator.publicKey,
    order: orderPda,
    vault: vaultPda,
    creatorTokenAccount: creatorTokenAccount,  // For dust (if any)
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([creator])
  .rpc();
// Order account is now closed, rent recovered
```

### 7. adminResolveTicket(releaseToFiatGuy)

**Purpose**: Emergency admin resolution for disputed tickets

**Parameters**:
- `releaseToFiatGuy: bool` - true = payout to FiatGuy, false = refund to CryptoGuy

**When to use**:
- Disputes requiring admin intervention
- Emergency resolution when normal flow is stuck
- **Only callable by hardcoded ADMIN_PUBKEY**

**Required accounts**:
```ts
{
  admin: Signer,                       // Must match ADMIN_PUBKEY constant
  order: Account,                      // Parent order PDA
  vault: Account,                      // Order's token vault
  ticket: Account,                     // Ticket to resolve
  fiatGuyTokenAccount?: Account,       // Always provide (program validates)
  cryptoGuyTokenAccount?: Account,     // Always provide (program validates)
  tokenProgram: PublicKey,
}
```

**Behavior**:

**If `releaseToFiatGuy = true` (Payout)**:
- Transfers `ticket.amount` from vault to FiatGuy's ATA
- Updates `order.filled_amount += amount`
- Updates `order.reserved_amount -= amount`
- Marks ticket as settled

**If `releaseToFiatGuy = false` (Refund)**:
- **Sell orders**: Refunds to creator, reduces `order.crypto_amount` by amount
- **Buy orders**: Refunds to acceptor (CryptoGuy)
- Updates `order.reserved_amount -= amount`
- Marks ticket as refunded

**Security**:
- Only transactions from ADMIN_PUBKEY succeed
- Validates ATA ownership (prevents sending to wrong wallets)
- Only participants in the order can receive funds

**TypeScript Example (Admin Payout)**:
```ts
await program.methods
  .adminResolveTicket(true)  // Release to FiatGuy
  .accounts({
    admin: adminKeypair.publicKey,     // Must match ADMIN_PUBKEY
    order: orderPda,
    vault: vaultPda,
    ticket: ticketPda,
    fiatGuyTokenAccount: buyerTokenAccount,
    cryptoGuyTokenAccount: sellerTokenAccount,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([adminKeypair])
  .rpc();
```

**TypeScript Example (Admin Refund)**:
```ts
await program.methods
  .adminResolveTicket(false)  // Refund to CryptoGuy
  .accounts({
    admin: adminKeypair.publicKey,
    order: orderPda,
    vault: vaultPda,
    ticket: ticketPda,
    fiatGuyTokenAccount: buyerTokenAccount,
    cryptoGuyTokenAccount: sellerTokenAccount,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([adminKeypair])
  .rpc();
```

### 8) adminResolveOrder(amount: u64)
- Admin-only order-level resolution. Prefer ticket-level where possible.
- Accounts:
  - admin: Signer (must equal ADMIN_PUBKEY)
  - order: PDA
  - vault: PDA
  - destinationAta: TokenAccount (mint must match; owner rules enforced per flow)
  - tokenProgram
- Behavior:
  - Sell: can move up to non-reserved remainder from vault to creator’s ATA, then shrink target accordingly. If no reserved and nothing remains, marks Cancelled.
  - Buy: no on-chain tokens; with no reservations, marks Cancelled by setting crypto_amount = filled.

## Complete Flow Examples

### Sell Order Flow (CryptoGuy → FiatGuy)

```ts
// 1. CryptoGuy creates Sell order and locks tokens
await program.methods
  .createOrder(orderId, cryptoAmount, fiatAmount, true)
  .accounts({
    creator: seller.publicKey,
    order: orderPda,
    mint,
    vault: vaultPda,
    creatorTokenAccount: sellerTokenAccount,  // Tokens locked here
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .signers([seller])
  .rpc();

// 2. FiatGuy accepts partial fill (no tokens needed)
await program.methods
  .acceptTicket(ticketId, fillAmount)
  .accounts({
    acceptor: buyer.publicKey,
    order: orderPda,
    vault: vaultPda,
    ticket: ticketPda,
    acceptorTokenAccount: null,  // Sell: no tokens from acceptor
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .signers([buyer])
  .rpc();

// 3a. FiatGuy signs first (confirms fiat payment)
await program.methods
  .signTicket()
  .accounts({
    signer: buyer.publicKey,
    order: orderPda,
    vault: vaultPda,
    ticket: ticketPda,
    fiatGuyTokenAccount: buyerTokenAccount,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([buyer])
  .rpc();

// 3b. CryptoGuy signs second (releases crypto, settlement happens)
await program.methods
  .signTicket()
  .accounts({
    signer: seller.publicKey,
    order: orderPda,
    vault: vaultPda,
    ticket: ticketPda,
    fiatGuyTokenAccount: buyerTokenAccount,  // Tokens sent here
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([seller])
  .rpc();
// Crypto is now transferred to buyer, ticket settled
```

### Buy Order Flow (FiatGuy → CryptoGuy)

```ts
// 1. FiatGuy creates Buy order (no tokens locked initially)
await program.methods
  .createOrder(orderId, cryptoAmount, fiatAmount, false)
  .accounts({
    creator: buyer.publicKey,
    order: orderPda,
    mint,
    vault: vaultPda,
    creatorTokenAccount: null,  // Buy: no tokens from creator
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .signers([buyer])
  .rpc();

// 2. CryptoGuy accepts and locks tokens immediately
await program.methods
  .acceptTicket(ticketId, fillAmount)
  .accounts({
    acceptor: seller.publicKey,
    order: orderPda,
    vault: vaultPda,
    ticket: ticketPda,
    acceptorTokenAccount: sellerTokenAccount,  // Buy: tokens from acceptor
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .signers([seller])
  .rpc();

// 3a. FiatGuy (creator) signs first
await program.methods
  .signTicket()
  .accounts({
    signer: buyer.publicKey,
    order: orderPda,
    vault: vaultPda,
    ticket: ticketPda,
    fiatGuyTokenAccount: buyerTokenAccount,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([buyer])
  .rpc();

// 3b. CryptoGuy signs second (settlement happens)
await program.methods
  .signTicket()
  .accounts({
    signer: seller.publicKey,
    order: orderPda,
    vault: vaultPda,
    ticket: ticketPda,
    fiatGuyTokenAccount: buyerTokenAccount,  // Tokens sent here
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([seller])
  .rpc();
```

## PDA Derivation Helpers

```ts
function deriveOrderPda(
  programId: PublicKey,
  creator: PublicKey,
  mint: PublicKey,
  orderId: number | anchor.BN
): [PublicKey, number] {
  const orderIdBN = typeof orderId === 'number' ? new anchor.BN(orderId) : orderId;
  return PublicKey.findProgramAddressSync([
    Buffer.from("universal_order"),
    creator.toBuffer(),
    mint.toBuffer(),
    orderIdBN.toArrayLike(Buffer, "le", 8),
  ], programId);
}

function deriveVaultPda(
  programId: PublicKey,
  orderPda: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([
    Buffer.from("vault"),
    orderPda.toBuffer(),
  ], programId);
}

function deriveTicketPda(
  programId: PublicKey,
  orderPda: PublicKey,
  ticketId: number | anchor.BN
): [PublicKey, number] {
  const ticketIdBN = typeof ticketId === 'number' ? new anchor.BN(ticketId) : ticketId;
  return PublicKey.findProgramAddressSync([
    Buffer.from("ticket"),
    orderPda.toBuffer(),
    ticketIdBN.toArrayLike(Buffer, "le", 8),
  ], programId);
}

// Usage example
const [orderPda] = deriveOrderPda(program.programId, creator, mint, orderId);
const [vaultPda] = deriveVaultPda(program.programId, orderPda);
const [ticketPda] = deriveTicketPda(program.programId, orderPda, ticketId);
```

## Error Handling

### Common Errors
- **`InvalidAmount`**: Amount below minimum or exceeds available
- **`RaceCondition`**: Rate limiting (cooldown/daily cap) or concurrency issues
- **`Unauthorized`**: Wrong signer, ATA owner, or admin key mismatch
- **`InvalidTokenAccount`**: ATA mint mismatch or wrong owner
- **`CannotCancel`**: Trying to cancel after fiat signed or invalid conditions
- **`OrderCompleted`**: Nothing left to cancel/resolve
- **`SignatureRequired`**: CryptoGuy tried to sign before FiatGuy (fiat-first rule)
- **`TokenAccountRequired`**: Missing required token account for the flow

### Error Handling Example
```ts
try {
  await program.methods
    .signTicket()
    .accounts({...})
    .signers([cryptoGuy])
    .rpc();
} catch (error) {
  if (error.message.includes('SignatureRequired')) {
    console.log('FiatGuy must sign first!');
  } else if (error.message.includes('InvalidAmount')) {
    console.log('Amount is below minimum or exceeds available');
  } else {
    console.log('Unexpected error:', error);
  }
}
```

## Constants & Limits

```ts
// From program constants (check current values)
const FILL_COOLDOWN_SECS = 5;           // 5 second cooldown
const MAX_FILLS_PER_DAY = 50;           // Daily fill limit
const ORDER_CLOSE_DUST = 1_000_000;     // 1 token dust threshold
```

## Event Monitoring

Key events to listen for:
- **`UniversalOrderCreated`**: New order created
- **`TicketAccepted`**: New partial fill created
- **`TicketSigned`**: Party signed a ticket
- **`TicketSettled`**: Ticket completed (both signed)
- **`TicketCancelled`**: Ticket cancelled
- **`OrderCancelled`**: Order cancelled by creator
- **`OrderClosed`**: Order account closed
- **`UniversalAdminResolved`**: Admin intervention

## Best Practices

1. **Always check available amount** before acceptTicket
2. **Respect rate limits** - implement cooldown UI
3. **Handle fiat-first rule** - disable CryptoGuy sign until FiatGuy signs
4. **Monitor events** for real-time updates
5. **Validate ATAs** before calling methods
6. **Use proper error handling** for all program calls
7. **Cache PDA derivations** to avoid repeated calculations
