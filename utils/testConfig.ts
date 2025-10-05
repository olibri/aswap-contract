import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { Ddd } from "../target/types/ddd";
import * as dotenv from "dotenv";
import * as path from "path";

// Завантажуємо змінні середовища з .env файлу
dotenv.config({ path: path.join(__dirname, '.env') });

/**
 * 🔧 Shared Test Configuration
 * 
 * Цей файл містить всі спільні конфігурації для тестів:
 * - RPC підключення
 * - Wallet'и
 * - Константи
 * - Utility функції
 * 
 * Всі конфігурації читаються тільки з .env файлу!
 */

// ═══════════════════════════════════════════════════════════════════
// 🌐 RPC Configuration
// ═══════════════════════════════════════════════════════════════════

export const RPC_CONFIG = {
    HTTP: process.env.RPC_HTTP!,
    WS: process.env.RPC_WS!,
    // Fallback до публічних RPC
    HTTP_FALLBACK: process.env.RPC_HTTP_FALLBACK!,
    WS_FALLBACK: process.env.RPC_WS_FALLBACK!,
};

export const CONNECTION_CONFIG = {
    commitment: process.env.CONNECTION_COMMITMENT! as anchor.web3.Commitment,
    wsEndpoint: RPC_CONFIG.WS,
    confirmTransactionInitialTimeout: parseInt(process.env.CONNECTION_CONFIRM_TIMEOUT!),
};

// ═══════════════════════════════════════════════════════════════════
// 👛 Test Wallets
// ═══════════════════════════════════════════════════════════════════

export const TEST_WALLETS = {
    buyer: Keypair.fromSecretKey(bs58.decode(process.env.TEST_BUYER_PRIVATE_KEY!)),
    seller: Keypair.fromSecretKey(bs58.decode(process.env.TEST_SELLER_PRIVATE_KEY!)),
};

// ═══════════════════════════════════════════════════════════════════
// 🪙 Token Configuration
// ═══════════════════════════════════════════════════════════════════

export const TOKEN_CONFIG = {
    USDC_MINT: new PublicKey(process.env.USDC_MINT!),
    FIAT: process.env.TOKEN_FIAT!,
    PRICE: new anchor.BN(parseInt(process.env.TOKEN_PRICE!)),
    OFFER_TYPE_BUY: { buy: {} },
    OFFER_TYPE_SELL: { sell: {} },
};

// ═══════════════════════════════════════════════════════════════════
// 🔢 Test Constants
// ═══════════════════════════════════════════════════════════════════

export const TEST_CONSTANTS = {
    AMOUNT_TO_LOCK: new anchor.BN(parseInt(process.env.AMOUNT_TO_LOCK!)),
    ESCROW_SEED: process.env.ESCROW_SEED!,
    VAULT_AUTHORITY_SEED: process.env.VAULT_AUTHORITY_SEED!,
    FILL_COOLDOWN_SECS: parseInt(process.env.FILL_COOLDOWN_SECS!),
};

// ═══════════════════════════════════════════════════════════════════
// 🛠 Helper Functions
// ═══════════════════════════════════════════════════════════════════

export async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForCooldown(): Promise<void> {
    const cooldownMs = (TEST_CONSTANTS.FILL_COOLDOWN_SECS + 2) * 1000; 
    console.log(`⏳ Waiting for cooldown period (${TEST_CONSTANTS.FILL_COOLDOWN_SECS + 2} seconds)...`);
    await sleep(cooldownMs);
}

// Обгортка для RPC викликів з додатковою стабільністю
export async function stableRpc(txBuilder: any, signers: any[] = [], waitMs?: number): Promise<string> {
    const defaultWaitMs = parseInt(process.env.WAIT_MS_DEFAULT!);
    const actualWaitMs = waitMs || defaultWaitMs;
    
    console.log("📡 Sending transaction...");
    const signature = await txBuilder.signers(signers).rpc();
    console.log(`✅ Transaction confirmed: ${signature}`);
    console.log(`⏳ Waiting ${actualWaitMs}ms for network finalization...`);
    await sleep(actualWaitMs);
    return signature;
}

// ═══════════════════════════════════════════════════════════════════
// 🏗 Setup Functions
// ═══════════════════════════════════════════════════════════════════

/**
 * Створює стандартне підключення для тестів
 */
export function createTestConnection(): anchor.web3.Connection {
    return new anchor.web3.Connection(RPC_CONFIG.HTTP, CONNECTION_CONFIG);
}

/**
 * Створює стандартний provider для тестів
 */
export function createTestProvider(connection?: anchor.web3.Connection): anchor.AnchorProvider {
    const conn = connection || createTestConnection();
    const wallet = anchor.Wallet.local();
    
    return new anchor.AnchorProvider(conn, wallet, {
        commitment: CONNECTION_CONFIG.commitment,
    });
}

/**
 * Повне налаштування Anchor середовища
 */
export function setupAnchorEnvironment() {
    const connection = createTestConnection();
    const provider = createTestProvider(connection);
    
    anchor.setProvider(provider);
    
    return {
        connection,
        provider,
        program: anchor.workspace.Ddd as anchor.Program<Ddd>,
    };
}

export default {
    RPC_CONFIG,
    CONNECTION_CONFIG,
    TEST_WALLETS,
    TOKEN_CONFIG,
    TEST_CONSTANTS,
    sleep,
    waitForCooldown,
    stableRpc,
    createTestConnection,
    createTestProvider,
    setupAnchorEnvironment,
};