import * as anchor from "@coral-xyz/anchor";
import { 
    Connection, 
    Keypair, 
    PublicKey, 
    Transaction, 
    SystemProgram,
    LAMPORTS_PER_SOL
} from "@solana/web3.js";
import { fundWallet } from "./solFunder";
import * as dotenv from "dotenv";
import * as path from "path";
import {
    createMint,
    createAccount,
    mintTo,
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    getAccount,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    MINT_SIZE,
    createInitializeMintInstruction,
    getMinimumBalanceForRentExemptMint,
    getMintLen,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createMintToInstruction,
} from "@solana/spl-token";

// Завантажуємо змінні середовища з .env файлу
dotenv.config({ path: path.join(__dirname, '.env') });

// Test Token Constants from ENV - тільки з ENV!
export const TEST_TOKEN_AMOUNT_10 = parseInt(process.env.TEST_TOKEN_AMOUNT_10!);
export const TEST_TOKEN_AMOUNT_100 = parseInt(process.env.TEST_TOKEN_AMOUNT_100!);

export interface TestTokenSetup {
    mint: PublicKey;
    mintAuthority: Keypair;
    decimals: number;
}

export interface UserTokenAccount {
    user: Keypair;
    tokenAccount: PublicKey;
    balance: number;
}

/**
 * Створює новий SPL токен для тестування
 */
export async function createTestToken(
    connection: Connection,
    payer: Keypair,
    decimals: number = 6
): Promise<TestTokenSetup> {
    console.log("🔧 Creating test SPL token...");
    
    // Створюємо keypair для mint authority
    const mintAuthority = Keypair.generate();
    
    // Створюємо mint
    const mint = await createMint(
        connection,
        payer,           // payer
        mintAuthority.publicKey,  // mint authority
        null,           // freeze authority (none)
        decimals        // decimals
    );
    
    console.log("✅ Test token created:");
    console.log("   Mint:", mint.toBase58());
    console.log("   Authority:", mintAuthority.publicKey.toBase58());
    console.log("   Decimals:", decimals);
    
    return {
        mint,
        mintAuthority,
        decimals
    };
}

/**
 * Створює токен акаунт для користувача і mint'ить токени
 */
export async function setupUserWithTokens(
    connection: Connection,
    payer: Keypair,
    user: Keypair,
    tokenSetup: TestTokenSetup,
    amount: number
): Promise<UserTokenAccount> {
    console.log(`🔧 Setting up user ${user.publicKey.toBase58().slice(0, 8)}... with ${amount} tokens`);
    
    // Отримуємо або створюємо ATA
    const tokenAccount = await getAssociatedTokenAddress(
        tokenSetup.mint,
        user.publicKey
    );
    
    // Перевіряємо чи існує акаунт
    let accountExists = false;
    try {
        await getAccount(connection, tokenAccount);
        accountExists = true;
        console.log("   Token account already exists");
    } catch (err) {
        console.log("   Creating new token account");
    }
    
    // Створюємо акаунт якщо не існує
    if (!accountExists) {
        const createATAIx = createAssociatedTokenAccountInstruction(
            payer.publicKey,     // payer
            tokenAccount,        // associated token account
            user.publicKey,      // owner
            tokenSetup.mint      // mint
        );
        
        const tx = new Transaction().add(createATAIx);
        await connection.sendTransaction(tx, [payer]);
        await sleep(1000);
    }
    
    // Mint токени на акаунт
    await mintTo(
        connection,
        payer,                        // payer
        tokenSetup.mint,             // mint
        tokenAccount,                // destination
        tokenSetup.mintAuthority,    // mint authority
        amount                       // amount
    );
    
    console.log(`✅ User setup completed with ${amount} tokens`);
    
    return {
        user,
        tokenAccount,
        balance: amount
    };
}

/**
 * Mint'ить додаткові токени на існуючий акаунт
 */
export async function mintMoreTokens(
    connection: Connection,
    payer: Keypair,
    tokenAccount: PublicKey,
    tokenSetup: TestTokenSetup,
    amount: number
): Promise<void> {
    console.log(`🔄 Minting ${amount} additional tokens...`);
    
    await mintTo(
        connection,
        payer,
        tokenSetup.mint,
        tokenAccount,
        tokenSetup.mintAuthority,
        amount
    );
    
    console.log("✅ Additional tokens minted");
}

/**
 * Перевіряє баланс токенів
 */
export async function getTokenBalance(
    connection: Connection,
    tokenAccount: PublicKey
): Promise<number> {
    try {
        const account = await getAccount(connection, tokenAccount);
        return Number(account.amount);
    } catch (err) {
        return 0;
    }
}

// Видалено - використовуємо solFunder.ts

/**
 * Автоматично налаштовує повне тестове середовище
 */
export async function setupTestEnvironment(
    connection: Connection,
    payer: Keypair,
    users: Keypair[],
    tokenAmountPerUser: number = 100_000_000, // 100 токенів з 6 decimals
    decimals: number = 6
): Promise<{
    tokenSetup: TestTokenSetup;
    userAccounts: UserTokenAccount[];
}> {
    console.log("🚀 Setting up complete test environment...");
    
    // Створюємо тестовий токен
    const tokenSetup = await createTestToken(connection, payer, decimals);
    
    // Налаштовуємо користувачів
    const userAccounts: UserTokenAccount[] = [];
    
    for (const user of users) {
        // Забезпечуємо SOL з донорського wallet'а
        await fundWallet(connection, user.publicKey, 0.1);
        
        // Створюємо токен акаунт і mint'імо токени
        const userAccount = await setupUserWithTokens(
            connection,
            payer,
            user,
            tokenSetup,
            tokenAmountPerUser
        );
        
        userAccounts.push(userAccount);
        
        // Невелика затримка між користувачами
        await sleep(500);
    }
    
    console.log("🎉 Test environment setup completed!");
    console.log(`   Token: ${tokenSetup.mint.toBase58()}`);
    console.log(`   Users: ${users.length}`);
    console.log(`   Tokens per user: ${tokenAmountPerUser}`);
    
    return {
        tokenSetup,
        userAccounts
    };
}

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Експортуємо також константи для зручності
export const TEST_TOKEN_DECIMALS = parseInt(process.env.TOKEN_DECIMALS!);
export const TEST_TOKEN_AMOUNT_1 = 1_000_000;      // 1 токен (залишаємо статичним)

/**
 * ===== TOKEN-2022 SUPPORT =====
 */

export interface TestToken {
    mint: PublicKey;
    mintAuthority: Keypair;
    decimals: number;
    tokenProgram: PublicKey;
    isToken2022: boolean;
}

/**
 * Створює Token-2022 для тестування
 */
export async function createToken2022(
    connection: Connection,
    payer: Keypair,
    decimals: number = 6
): Promise<TestToken> {
    console.log("🔧 Creating Token-2022...");
    
    const mintAuthority = Keypair.generate();
    const mintKeypair = Keypair.generate();
    
    const lamports = await connection.getMinimumBalanceForRentExemption(
        getMintLen([])
    );

    const transaction = new Transaction().add(
        SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: mintKeypair.publicKey,
            space: getMintLen([]),
            lamports,
            programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeMintInstruction(
            mintKeypair.publicKey,
            decimals,
            mintAuthority.publicKey,
            null,
            TOKEN_2022_PROGRAM_ID
        )
    );

    await connection.sendTransaction(transaction, [payer, mintKeypair]);
    await sleep(1000);

    console.log("✅ Token-2022 created:");
    console.log("   Mint:", mintKeypair.publicKey.toBase58());
    console.log("   Authority:", mintAuthority.publicKey.toBase58());
    
    return {
        mint: mintKeypair.publicKey,
        mintAuthority,
        decimals,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        isToken2022: true,
    };
}

/**
 * Wrapper для створення SPL Token з однаковим інтерфейсом
 */
export async function createSPLTokenWithMetadata(
    connection: Connection,
    payer: Keypair,
    decimals: number = 6
): Promise<TestToken> {
    console.log("🔧 Creating SPL Token...");
    
    const mintAuthority = Keypair.generate();
    
    const mint = await createMint(
        connection,
        payer,
        mintAuthority.publicKey,
        null,
        decimals,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
    );
    
    console.log("✅ SPL Token created:");
    console.log("   Mint:", mint.toBase58());
    console.log("   Authority:", mintAuthority.publicKey.toBase58());
    
    return {
        mint,
        mintAuthority,
        decimals,
        tokenProgram: TOKEN_PROGRAM_ID,
        isToken2022: false,
    };
}

/**
 * Створює токен акаунт для обох типів токенів
 */
export async function createUniversalTokenAccount(
    connection: Connection,
    payer: Keypair,
    mint: PublicKey,
    owner: PublicKey,
    tokenProgram: PublicKey
): Promise<PublicKey> {
    const ata = await getAssociatedTokenAddress(
        mint,
        owner,
        false,
        tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const accountInfo = await connection.getAccountInfo(ata);
    
    if (!accountInfo) {
        const transaction = new Transaction().add(
            createAssociatedTokenAccountInstruction(
                payer.publicKey,
                ata,
                owner,
                mint,
                tokenProgram,
                ASSOCIATED_TOKEN_PROGRAM_ID
            )
        );

        await connection.sendTransaction(transaction, [payer]);
        await sleep(1000);
        console.log(`✅ Token account created: ${ata.toBase58()}`);
    }

    return ata;
}

/**
 * Mint токени для обох типів
 */
export async function mintUniversalTokens(
    connection: Connection,
    payer: Keypair,
    mint: PublicKey,
    destination: PublicKey,
    mintAuthority: Keypair,
    amount: number | bigint,
    tokenProgram: PublicKey
): Promise<void> {
    const transaction = new Transaction().add(
        createMintToInstruction(
            mint,
            destination,
            mintAuthority.publicKey,
            amount,
            [],
            tokenProgram
        )
    );

    await connection.sendTransaction(transaction, [payer, mintAuthority]);
    await sleep(500);
}

/**
 * Повна настройка тестового токена (SPL або Token-2022) з користувачами
 */
export async function setupUniversalTestToken(
    connection: Connection,
    payer: Keypair,
    users: Keypair[],
    isToken2022: boolean = false,
    decimals: number = 6,
    initialBalance: number = 1_000_000_000
): Promise<{
    token: TestToken;
    accounts: Map<string, PublicKey>;
}> {
    console.log(`🚀 Setting up ${isToken2022 ? 'Token-2022' : 'SPL Token'} environment...`);
    
    // Створюємо токен
    const token = isToken2022
        ? await createToken2022(connection, payer, decimals)
        : await createSPLTokenWithMetadata(connection, payer, decimals);

    // Створюємо акаунти для всіх користувачів
    const accounts = new Map<string, PublicKey>();
    
    for (const user of users) {
        const ata = await createUniversalTokenAccount(
            connection,
            payer,
            token.mint,
            user.publicKey,
            token.tokenProgram
        );
        
        // Mint початковий баланс
        await mintUniversalTokens(
            connection,
            payer,
            token.mint,
            ata,
            token.mintAuthority,
            initialBalance,
            token.tokenProgram
        );
        
        accounts.set(user.publicKey.toBase58(), ata);
    }

    console.log(`✅ Test token setup complete!`);
    console.log(`   Type: ${isToken2022 ? 'Token-2022' : 'SPL Token'}`);
    console.log(`   Mint: ${token.mint.toBase58()}`);
    console.log(`   Users: ${users.length}`);
    
    return { token, accounts };
}