import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import * as dotenv from "dotenv";
import * as path from "path";

// Завантажуємо змінні середовища з .env файлу
dotenv.config({ path: path.join(__dirname, '.env') });

/**
 * 🔑 ДОНОРСЬКИЙ WALLET (Base58 формат) - читається тільки з ENV
 */
const DONOR_WALLET_SECRET_BASE58 = process.env.DONOR_WALLET_PRIVATE_KEY!;

let donorWallet: Keypair | null = null;

/**
 * Ініціалізує донорський wallet
 */
function initDonorWallet(): Keypair {
    if (!donorWallet) {        
        donorWallet = Keypair.fromSecretKey(bs58.decode(DONOR_WALLET_SECRET_BASE58));
        console.log("💰 Donor wallet loaded:", donorWallet.publicKey.toBase58());
    }
    return donorWallet;
}

/**
 * Перевіряє баланс донорського wallet'а
 */
export async function checkDonorBalance(connection: Connection): Promise<number> {
    const donor = initDonorWallet();
    const balance = await connection.getBalance(donor.publicKey);
    const solBalance = balance / LAMPORTS_PER_SOL;
    const minimumBalance = parseFloat(process.env.MINIMUM_DONOR_BALANCE!);
    
    console.log(`💰 Donor wallet balance: ${solBalance} SOL`);
    
    if (solBalance < minimumBalance) {
        console.warn("⚠️ LOW BALANCE! Please airdrop SOL to donor wallet:");
        console.warn(`   solana airdrop 2 ${donor.publicKey.toBase58()} --url devnet`);
    }
    
    return solBalance;
}

/**
 * Відправляє SOL з донорського wallet'а на цільовий
 */
export async function fundWallet(
    connection: Connection, 
    targetWallet: PublicKey, 
    solAmount?: number
): Promise<void> {
    const defaultAmount = parseFloat(process.env.DEFAULT_FUNDING_AMOUNT!);
    const actualAmount = solAmount || defaultAmount;
    const donor = initDonorWallet();
    const lamports = Math.floor(actualAmount * LAMPORTS_PER_SOL);
    
    console.log(`🔄 Funding ${targetWallet.toBase58().slice(0, 8)}... with ${actualAmount} SOL`);
    
    try {
        // Перевіряємо поточний баланс цільового wallet'а
        const currentBalance = await connection.getBalance(targetWallet);
        const currentSol = currentBalance / LAMPORTS_PER_SOL;
        
        if (currentSol >= actualAmount) {
            console.log(`✅ Target wallet already has ${currentSol} SOL (enough)`);
            return;
        }
        
        // Відправляємо SOL
        const transaction = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: donor.publicKey,
                toPubkey: targetWallet,
                lamports: lamports,
            })
        );
        
        const signature = await connection.sendTransaction(transaction, [donor]);
        await connection.confirmTransaction(signature, 'confirmed');
        
        const newBalance = await connection.getBalance(targetWallet);
        const newSol = newBalance / LAMPORTS_PER_SOL;
        
        console.log(`✅ Funded successfully! New balance: ${newSol} SOL`);
        
    } catch (error) {
        console.error(`❌ Failed to fund wallet:`, error);
        throw error;
    }
}

/**
 * Масово фундить кілька wallet'ів
 */
export async function fundMultipleWallets(
    connection: Connection,
    wallets: PublicKey[],
    solAmountEach?: number
): Promise<void> {
    const defaultAmount = parseFloat(process.env.DEFAULT_FUNDING_AMOUNT!);
    const actualAmount = solAmountEach || defaultAmount;
    
    console.log(`🚀 Funding ${wallets.length} wallets with ${actualAmount} SOL each...`);
    
    await checkDonorBalance(connection);
    
    for (let i = 0; i < wallets.length; i++) {
        await fundWallet(connection, wallets[i], actualAmount);
        
        // Невелика затримка між транзакціями
        if (i < wallets.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    console.log("🎉 All wallets funded successfully!");
}

/**
 * Збирає залишки SOL з wallet'а назад на донорський wallet
 */
export async function collectSOLFromWallet(
    connection: Connection,
    sourceWallet: Keypair,
    keepAmount: number = 0.01 // Залишити мінімум для закриття акаунтів
): Promise<void> {
    const donor = initDonorWallet();
    
    try {
        const balance = await connection.getBalance(sourceWallet.publicKey);
        const solBalance = balance / LAMPORTS_PER_SOL;
        
        if (solBalance <= keepAmount) {
            console.log(`ℹ️ Wallet ${sourceWallet.publicKey.toBase58().slice(0, 8)} has only ${solBalance} SOL (keeping it)`);
            return;
        }
        
        // Розраховуємо скільки повернути (залишаємо трохи для rent exemption)
        const rentExemption = 0.002; // ~0.002 SOL для rent exemption
        const amountToReturn = solBalance - keepAmount - rentExemption;
        
        if (amountToReturn <= 0) {
            console.log(`ℹ️ Nothing to collect from ${sourceWallet.publicKey.toBase58().slice(0, 8)}`);
            return;
        }
        
        const lamportsToReturn = Math.floor(amountToReturn * LAMPORTS_PER_SOL);
        
        console.log(`🔄 Collecting ${amountToReturn.toFixed(4)} SOL from ${sourceWallet.publicKey.toBase58().slice(0, 8)}...`);
        
        const transaction = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: sourceWallet.publicKey,
                toPubkey: donor.publicKey,
                lamports: lamportsToReturn,
            })
        );
        
        const signature = await connection.sendTransaction(transaction, [sourceWallet]);
        await connection.confirmTransaction(signature, 'confirmed');
        
        const newDonorBalance = await connection.getBalance(donor.publicKey);
        console.log(`✅ Collected! Donor balance: ${(newDonorBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        
    } catch (error) {
        console.warn(`⚠️ Failed to collect SOL from ${sourceWallet.publicKey.toBase58().slice(0, 8)}:`, error);
    }
}

/**
 * Збирає залишки SOL з масиву wallet'ів
 */
export async function collectSOLFromMultipleWallets(
    connection: Connection,
    wallets: Keypair[],
    keepAmountEach: number = 0.01
): Promise<void> {
    console.log(`🔄 Collecting SOL from ${wallets.length} test wallets...`);
    
    let totalCollected = 0;
    const donor = initDonorWallet();
    const initialDonorBalance = await connection.getBalance(donor.publicKey);
    
    for (const wallet of wallets) {
        await collectSOLFromWallet(connection, wallet, keepAmountEach);
        
        // Невелика затримка між операціями
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    const finalDonorBalance = await connection.getBalance(donor.publicKey);
    totalCollected = (finalDonorBalance - initialDonorBalance) / LAMPORTS_PER_SOL;
    
    console.log(`🎉 Collection completed! Total collected: ${totalCollected.toFixed(4)} SOL`);
    console.log(`💰 Final donor balance: ${(finalDonorBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
}

/**
 * Перевіряє та показує залишки всіх wallet'ів
 */
export async function showWalletBalances(
    connection: Connection, 
    wallets: { name: string; keypair: Keypair }[]
): Promise<void> {
    console.log("💰 Wallet balances:");
    
    for (const { name, keypair } of wallets) {
        try {
            const balance = await connection.getBalance(keypair.publicKey);
            const solBalance = balance / LAMPORTS_PER_SOL;
            console.log(`   ${name}: ${solBalance.toFixed(4)} SOL`);
        } catch (error) {
            console.log(`   ${name}: Error reading balance`);
        }
    }
}