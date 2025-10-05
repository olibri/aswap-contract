# Universal Orders - Frontend API

## Методи

### 1. createOrder
```ts
// Параметри
order_id: u64
crypto_amount: u64  
fiat_amount: u64
is_sell_order: bool

// Акаунти
creator: Signer
order: PDA ["universal_order", creator, mint, order_id]
mint: TokenMint
vault: PDA ["vault", order]  
creator_token_account: TokenAccount (якщо is_sell_order=true)
token_program: TokenProgram
system_program: SystemProgram
```

### 2. acceptTicket  
```ts
// Параметри
ticket_id: u64
amount: u64

// Акаунти
acceptor: Signer
order: UniversalOrder PDA
vault: PDA ["vault", order]
ticket: PDA ["ticket", order, ticket_id]
acceptor_token_account: TokenAccount (якщо order.is_sell_order=false)
token_program: TokenProgram  
system_program: SystemProgram
```

### 3. signTicket
```ts
// Параметри
(немає)

// Акаунти  
signer: Signer
order: UniversalOrder PDA
vault: PDA ["vault", order]
ticket: FillTicket PDA
fiat_guy_token_account: TokenAccount
token_program: TokenProgram
```

### 4. cancelTicket
```ts
// Параметри
(немає)

// Акаунти
canceler: Signer
order: UniversalOrder PDA  
vault: PDA ["vault", order]
ticket: FillTicket PDA
canceler_token_account: TokenAccount (залежить від ролі)
token_program: TokenProgram
```

### 5. cancelOrder
```ts
// Параметри
(немає)

// Акаунти
creator: Signer
order: UniversalOrder PDA
vault: PDA ["vault", order] 
creator_token_account: TokenAccount
token_program: TokenProgram
```

### 6. closeOrder
```ts
// Параметри  
(немає)

// Акаунти
creator: Signer
order: UniversalOrder PDA
vault: PDA ["vault", order]
creator_token_account: TokenAccount
token_program: TokenProgram
system_program: SystemProgram
```

### 7. adminResolveTicket
```ts
// Параметри
should_payout: bool

// Акаунти
admin: Signer (має бути ADMIN_PUBKEY)
order: UniversalOrder PDA
vault: PDA ["vault", order]
ticket: FillTicket PDA  
fiat_guy_token_account: TokenAccount
crypto_guy_token_account: TokenAccount
token_program: TokenProgram
```

### 8. adminResolveOrder  
```ts
// Параметри
should_payout: bool

// Акаунти
admin: Signer (має бути ADMIN_PUBKEY)
order: UniversalOrder PDA
vault: PDA ["vault", order]
creator_token_account: TokenAccount
token_program: TokenProgram
```

## PDA Seeds
- Order: `["universal_order", creator_pubkey, mint_pubkey, order_id_le_bytes]`
- Vault: `["vault", order_pda]` 
- Ticket: `["ticket", order_pda, ticket_id_le_bytes]`

## Правила
- Sell order: CryptoGuy створює, токени блокуються відразу
- Buy order: FiatGuy створює, токени блокуються при acceptTicket
- FiatGuy завжди підписує першим у signTicket
- Rate limiting на acceptTicket (cooldown + daily cap)