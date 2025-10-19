# New Universal Orders Flow (Simplified)

## 🎯 Core Concept
- Offers created in DB first (no blockchain)
- Blockchain transaction only when counterparty accepts
- Auto-close on completion or cancellation
- All rent paid and returned to Admin

---

## 📝 Instructions Available

### 1. `accept_offer_and_lock`
**Purpose**: Create order + vault + ticket, lock tokens (first blockchain interaction)

**Who calls**: CryptoGuy (via frontend)

**When**: When counterparty accepts DB offer

**What it does**:
- Creates order PDA
- Creates vault PDA
- Creates first ticket PDA (ticket_id = 1)
- Locks CryptoGuy's tokens into vault
- Emits `OfferAccepted` event

**Accounts**:
- `locker` (CryptoGuy) - signer, locks tokens
- `fee_payer` (Admin) - pays rent for order + vault + ticket
- `order` (init) - new order PDA
- `vault` (init) - new vault PDA
- `ticket` (init) - new ticket PDA
- `locker_token_account` - CryptoGuy's token account

---

### 2. `sign_universal_ticket`
**Purpose**: Sign ticket; settles on second signature

**Who calls**: First FiatGuy, then CryptoGuy

**Business rule**: FiatGuy MUST sign first

**What it does**:
- Marks signature (fiat_guy_signed or crypto_guy_signed)
- On both signatures:
  - Transfers 99.8% to FiatGuy
  - Transfers 0.2% fee to Admin
  - Updates order.filled_amount
  - Closes ticket (rent → admin)
  - **AUTO-CLOSE**: If order complete, closes vault + order (rent → admin)

**Emits**:
- `TicketSigned` (each signature)
- `TicketSettled` (on both signatures)
- `OrderClosed` (if auto-closed)

---

### 3. `cancel_universal_ticket`
**Purpose**: Cancel ticket before FiatGuy signs

**Who calls**: FiatGuy ONLY

**When**: Before FiatGuy signs (e.g., CryptoGuy didn't come, offer expired)

**What it does**:
- Refunds all tokens from vault → CryptoGuy
- Closes ticket (rent → admin)
- **AUTO-CLOSE**: Closes vault + order (rent → admin)

**Restrictions**:
- Only FiatGuy can cancel
- Only before FiatGuy signs (`!ticket.fiat_guy_signed`)
- CryptoGuy CANNOT cancel

**Emits**:
- `TicketCancelled`
- `OrderClosed`

---

### 4. `admin_resolve_universal_order`
**Purpose**: Emergency admin intervention (order-level)

---

### 5. `admin_resolve_universal_ticket`
**Purpose**: Emergency admin intervention (ticket-level)

---

## 🔄 Complete Flow Examples

### SELL Order (CryptoGuy sells 100 USDC for 3000 UAH)

```
1. CryptoGuy creates offer in DB
   → Frontend: POST /api/offers
   → Backend: INSERT into offers { type: "SELL", status: "open", blockchain_order_id: null }
   → Blockchain: ❌ Nothing

2. FiatGuy sees offer, clicks "Buy"
   → Frontend: POST /api/offers/{id}/accept
   → Backend: Creates match in DB, returns transaction data
   → Frontend: Notifies CryptoGuy (WebSocket/Push)

3. CryptoGuy frontend calls accept_offer_and_lock
   → Blockchain: ✅ Order PDA + Vault PDA + Ticket PDA created, 100 USDC locked
   → Event: OfferAccepted
   → Indexer: Updates DB with blockchain_order_id, order_pda, vault_pda, ticket_pda

4. FiatGuy transfers 3000 UAH (off-chain)
   → Monobank/Privat24/etc.
   → Frontend: Marks "I paid"

5. FiatGuy signs ticket
   → Frontend: program.methods.signUniversalTicket()
   → Blockchain: ✅ ticket.fiat_guy_signed = true
   → Event: TicketSigned

6. CryptoGuy confirms fiat received, signs ticket
   → Frontend: program.methods.signUniversalTicket()
   → Blockchain: ✅ Settlement! 99.8 USDC → FiatGuy, 0.2 USDC → Admin
   → AUTO-CLOSE: Ticket closed, Vault closed, Order closed (all rent → Admin)
   → Events: TicketSigned, TicketSettled, OrderClosed
```

---

### BUY Order (FiatGuy buys 50 USDC for 1500 UAH)

```
1. FiatGuy creates offer in DB
   → Frontend: POST /api/offers
   → Backend: INSERT into offers { type: "BUY", status: "open", blockchain_order_id: null }
   → Blockchain: ❌ Nothing

2. CryptoGuy sees offer, clicks "Sell"
   → Frontend: POST /api/offers/{id}/accept
   → Backend: Creates match, notifies CryptoGuy

3. CryptoGuy frontend calls accept_offer_and_lock
   → Blockchain: ✅ Order PDA + Vault PDA + Ticket PDA created, 50 USDC locked
   → Event: OfferAccepted
   → Indexer: Updates DB

4-6. Same signature flow as SELL order
```

---

### Cancel Flow (FiatGuy cancels before signing)

```
Scenario: CryptoGuy created SELL offer, FiatGuy accepted, but CryptoGuy never came online

1. FiatGuy waits 15 minutes (or offer expires)
2. FiatGuy clicks "Cancel"
   → Frontend: program.methods.cancelUniversalTicket()
   → Blockchain: ✅ Refund 100 USDC → CryptoGuy
   → AUTO-CLOSE: Ticket closed, Vault closed, Order closed (all rent → Admin)
   → Events: TicketCancelled, OrderClosed
```

---

## 📡 Events

### `OfferAccepted` (NEW - replaces UniversalOrderCreated + TicketAccepted)
```rust
{
  order: Pubkey,
  order_id: u64,
  creator: Pubkey,
  crypto_mint: Pubkey,
  vault: Pubkey,
  is_sell_order: bool,
  crypto_amount: u64,
  fiat_amount: u64,
  ticket: Pubkey,
  ticket_id: u64,
  locked_amount: u64,
  crypto_guy: Pubkey,
  fiat_guy: Pubkey,
  timestamp: i64,
}
```

### `TicketSigned` (unchanged)
```rust
{
  order: Pubkey,
  ticket: Pubkey,
  signer: Pubkey,
  is_crypto_guy: bool,
  is_fiat_guy: bool,
  both_signed: bool,
  timestamp: i64,
}
```

### `TicketSettled` (unchanged)
```rust
{
  order: Pubkey,
  ticket: Pubkey,
  amount: u64,
  fee_amount: u64,      // 0.2%
  net_amount: u64,      // 99.8%
  fiat_guy: Pubkey,
  crypto_guy: Pubkey,
  total_filled: u64,
  timestamp: i64,
}
```

### `TicketCancelled` (unchanged)
```rust
{
  order: Pubkey,
  ticket: Pubkey,
  canceller: Pubkey,
  amount: u64,
  refunded: bool,
  timestamp: i64,
}
```

### `OrderClosed` (unchanged)
```rust
{
  order: Pubkey,
  creator: Pubkey,
  dust_amount: u64,
  rent_returned_to: Pubkey,
  timestamp: i64,
}
```

---

## 🔐 Security Rules

1. **CryptoGuy** is always the one who locks tokens (locker in accept_offer_and_lock)
2. **FiatGuy** must sign first (enforced in sign_ticket)
3. **Only FiatGuy** can cancel (enforced in cancel_ticket)
4. **Cancel only before FiatGuy signs** (enforced in cancel_ticket)
5. **Auto-close** ensures rent always returns to Admin
6. **Admin pays all rent** upfront (order + vault + ticket)

---

## 💰 Rent Economics

| Action | Rent Payer | Rent Receiver (on close) |
|--------|------------|--------------------------|
| accept_offer_and_lock | Admin | - |
| sign_ticket (both) | - | Admin (ticket + vault + order) |
| cancel_ticket | - | Admin (ticket + vault + order) |

**Net cost to Admin**: ~0 SOL (pays upfront, receives back on close)

---

## 🚫 Removed Instructions

- ~~`create_universal_order`~~ - No longer needed (merged into accept_offer_and_lock)
- ~~`lock_crypto_for_universal_ticket`~~ - No longer needed (merged into accept_offer_and_lock)
- ~~`cancel_universal_order`~~ - No longer needed (auto-close handles this)
- ~~`close_universal_order`~~ - No longer needed (auto-close handles this)

---

## 📊 Comparison: Old vs New

| Aspect | Old Flow | New Flow |
|--------|----------|----------|
| Order creation | 2 transactions (create + lock) | 1 transaction (accept_offer_and_lock) |
| Lock timing | Immediate (when offer created) | Delayed (when counterparty appears) |
| Cancel | Complex (order-level + ticket-level) | Simple (ticket-level only, FiatGuy only) |
| Close | Manual (close_order instruction) | Automatic (on settlement or cancel) |
| Events | 2 (OrderCreated + TicketAccepted) | 1 (OfferAccepted) |
| Rent management | Manual tracking | Auto-return to Admin |

---

## ✅ Benefits

1. **Less risk for CryptoGuy**: Tokens locked only when real buyer appears
2. **Simpler flow**: 1 transaction instead of 2
3. **Better UX**: No need to pre-lock large amounts
4. **Cleaner code**: Auto-close removes manual cleanup
5. **Cheaper**: Single transaction saves gas
6. **Atomic**: Order + ticket + lock in one transaction
