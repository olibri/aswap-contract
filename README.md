# 🔧 DDD Smart Contract - Environment Setup

## 🚨 IMPORTANT: Environment Configuration

This project uses environment variables to store sensitive data (private keys, API keys).

### 📋 Required Variables

Create a `utils/.env` file with the following variables:

```bash
# RPC Configuration
RPC_HTTP=https://devnet.helius-rpc.com/?api-key=YOUR_API_KEY
RPC_WS=wss://devnet.helius-rpc.com/?api-key=YOUR_API_KEY
RPC_HTTP_FALLBACK=https://api.devnet.solana.com
RPC_WS_FALLBACK=wss://api.devnet.solana.com/
CONNECTION_COMMITMENT=confirmed
CONNECTION_CONFIRM_TIMEOUT=120000

# Test Wallet Private Keys (Base58 format)
TEST_BUYER_PRIVATE_KEY=your_test_buyer_private_key_here
TEST_SELLER_PRIVATE_KEY=your_test_seller_private_key_here
DONOR_WALLET_PRIVATE_KEY=your_donor_wallet_private_key_here

# Token Configuration
USDC_MINT=Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr
TOKEN_FIAT=USD
TOKEN_PRICE=10000
TOKEN_DECIMALS=6

# Test Constants
TEST_TOKEN_AMOUNT_10=10000000
TEST_TOKEN_AMOUNT_100=100000000
AMOUNT_TO_LOCK=10000000
ESCROW_SEED=escrow
VAULT_AUTHORITY_SEED=vault_authority
FILL_COOLDOWN_SECS=2
WAIT_MS_DEFAULT=3000

# Funding Configuration
DEFAULT_FUNDING_AMOUNT=0.1
MINIMUM_DONOR_BALANCE=0.5
```

### 🔒 Security

- ❌ **NEVER** commit `.env` files
- ✅ Use test keys for development
- ✅ Store production keys securely
- ✅ Check .gitignore before every commit

### 🚀 Running Tests

```bash
# Install dependencies
npm install

# Run tests (requires .env file!)
anchor test
```

### 📖 Project Structure

- `programs/ddd/` - Solana smart contract (Rust)
- `tests/` - Test files (TypeScript)
- `utils/` - Utility functions and configuration
- `utils/.env` - Environment variables (NOT COMMITTED)