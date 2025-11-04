import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID,
    getOrCreateAssociatedTokenAccount,
    transfer,
} from "@solana/spl-token";
import { expect } from "chai";
import { Ddd } from "../target/types/ddd";
import { 
    setupTestEnvironment, 
    TestTokenSetup, 
    TEST_TOKEN_AMOUNT_100,
    getTokenBalance,
    mintMoreTokens
} from "../utils/testTokens";
import { checkDonorBalance } from "../utils/solFunder";
import { setupAnchorEnvironment, waitForCooldown, TEST_WALLETS } from "../utils/testConfig";
import {
    acceptOfferAndLock,
    signTicket,
    cancelTicket,
    deriveOrderPdas,
    deriveTicketPda
} from "../utils/orderHelpers";

describe.only("🧪 Universal Orders: New Flow Tests", () => {
    const { connection, provider, program } = setupAnchorEnvironment();

    let tokenSetup: TestTokenSetup;
    let cryptoGuy: Keypair;
    let fiatGuy: Keypair;
    let cryptoGuyTokenAccount: PublicKey;
    let fiatGuyTokenAccount: PublicKey;
    let adminTokenAccount: PublicKey; 
    const adminSigner = TEST_WALLETS.buyer; 

    const DECIMALS = 6;
    const usdc = (n: number) => new anchor.BN(Math.round(n * 1_000_000));

    // Helper to log admin SOL balance
    const logAdminBalance = async (label: string) => {
        const balance = await connection.getBalance(adminSigner.publicKey);
        console.log(`💰 ${label}: ${(balance / 1_000_000_000).toFixed(5)} SOL`);
        return balance;
    };

    before("setup token mint and users", async () => {
        await checkDonorBalance(connection);

        cryptoGuy = Keypair.generate();
        fiatGuy   = Keypair.generate();

        const env = await setupTestEnvironment(
            connection,
            provider.wallet.payer as Keypair,
            [cryptoGuy, fiatGuy],
            TEST_TOKEN_AMOUNT_100,
            DECIMALS,
        );
        tokenSetup = env.tokenSetup;
        cryptoGuyTokenAccount = env.userAccounts[0].tokenAccount;
        fiatGuyTokenAccount   = env.userAccounts[1].tokenAccount;

        const adminAtaInfo = await getOrCreateAssociatedTokenAccount(
            connection,
            provider.wallet.payer as Keypair,
            tokenSetup.mint,
            adminSigner.publicKey
        );
        adminTokenAccount = adminAtaInfo.address;

        const minLamports = 200_000_000;
        const current = await connection.getBalance(adminSigner.publicKey);
        if (current < minLamports) {
            const tx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: provider.wallet.publicKey,
                    toPubkey: adminSigner.publicKey,
                    lamports: minLamports - current + 50_000_000,
                })
            );
            await provider.sendAndConfirm(tx, [provider.wallet.payer as Keypair]);
        }
        console.log("👑 Admin funded:", (await connection.getBalance(adminSigner.publicKey)) / 1_000_000_000, "SOL");
    });

    after("cleanup", async function () {
        this.timeout(30000);
        try {
            if (!tokenSetup) return;
            const payer = provider.wallet.payer as Keypair;
            const mainAtaInfo = await getOrCreateAssociatedTokenAccount(
                connection, payer, tokenSetup.mint, payer.publicKey
            );
            const mainAta = mainAtaInfo.address;

            for (const user of [
                { owner: cryptoGuy, ata: cryptoGuyTokenAccount },
                { owner: fiatGuy, ata: fiatGuyTokenAccount },
            ]) {
                try {
                    const bal = await getTokenBalance(connection, user.ata);
                    if (bal > 0) {
                        await transfer(connection, payer, user.ata, mainAta, user.owner, bal);
                    }
                } catch (e) {}
            }
        } catch (e) {}
    });

    it.only("💰 RENT TEST: Admin SOL balance restored after full flow", async () => {
        const orderId = new anchor.BN(Date.now());
        const ticketId = new anchor.BN(1);
        const cryptoAmount = usdc(10);
        const fiatAmount = new anchor.BN(1000);

        console.log("\n💰 === RENT RECOVERY TEST ===");
        
        // Get admin SOL balance BEFORE creating accounts
        const adminBalanceBefore = await connection.getBalance(adminSigner.publicKey);
        console.log("🏦 Admin SOL before:", (adminBalanceBefore / 1_000_000_000).toFixed(5), "SOL");

        console.log("\n📦 Step 1: Accept offer & lock (admin pays rent for Order + Vault + Ticket)");
        const beforeCrypto = await getTokenBalance(connection, cryptoGuyTokenAccount);
        
        const { orderPda, vaultPda, ticketPda } = await acceptOfferAndLock(
            program, orderId, ticketId, cryptoAmount, fiatAmount, true,
            cryptoGuy.publicKey, fiatGuy.publicKey, cryptoGuy,
            cryptoGuyTokenAccount, tokenSetup.mint, adminSigner
        );

        await waitForCooldown();

        const adminBalanceAfterLock = await connection.getBalance(adminSigner.publicKey);
        const rentPaid = adminBalanceBefore - adminBalanceAfterLock;
        console.log("💸 Rent paid for accounts:", (rentPaid / 1_000_000_000).toFixed(5), "SOL");
        console.log("🏦 Admin SOL after lock:", (adminBalanceAfterLock / 1_000_000_000).toFixed(5), "SOL");

        const afterLock = await getTokenBalance(connection, cryptoGuyTokenAccount);
        const vaultBal = await getTokenBalance(connection, vaultPda);
        
        expect(beforeCrypto - afterLock).to.eq(cryptoAmount.toNumber());
        expect(vaultBal).to.eq(cryptoAmount.toNumber());
        console.log("✓ Locked:", vaultBal / 1_000_000, "USDC");

        console.log("\n✍️ Step 2: FiatGuy signs");
        await signTicket(
            program, fiatGuy, orderPda, vaultPda, ticketPda,
            fiatGuyTokenAccount, adminTokenAccount, adminSigner
        );
        await waitForCooldown();

        console.log("✍️ Step 3: CryptoGuy signs → settlement & auto-close");
        const beforeFiat = await getTokenBalance(connection, fiatGuyTokenAccount);

        const txSig = await signTicket(
            program, cryptoGuy, orderPda, vaultPda, ticketPda,
            fiatGuyTokenAccount, adminTokenAccount, adminSigner
        );

        await waitForCooldown();

        // Get transaction logs to see program messages
        const txDetails = await connection.getTransaction(txSig, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });
        
        if (txDetails?.meta?.logMessages) {
            console.log("\n📋 Transaction logs:");
            txDetails.meta.logMessages
                .filter(log => log.includes("Auto-close") || log.includes("Vault") || log.includes("Order closed"))
                .forEach(log => console.log("   ", log));
        }

        const afterFiat = await getTokenBalance(connection, fiatGuyTokenAccount);
        const fee = Math.floor(cryptoAmount.toNumber() * 20 / 10_000);
        expect(afterFiat - beforeFiat).to.eq(cryptoAmount.toNumber() - fee);
        console.log("✓ FiatGuy received:", (afterFiat - beforeFiat) / 1_000_000, "USDC");

        // Check vault balance AFTER settlement
        console.log("\n🔍 Checking accounts status...");
        try {
            const vaultInfo = await connection.getAccountInfo(vaultPda);
            if (vaultInfo) {
                const vaultBalance = await getTokenBalance(connection, vaultPda);
                console.log("🏦 Vault balance after settlement:", vaultBalance / 1_000_000, "USDC");
            } else {
                console.log("✓ Vault is closed");
            }
        } catch (e) {
            console.log("✓ Vault is closed");
        }

        // Verify accounts are closed
        try {
            const orderData = await program.account.universalOrder.fetch(orderPda);
            console.log("❌ Order still exists!");
            console.log("   - filled_amount:", orderData.filledAmount.toString());
            console.log("   - crypto_amount:", orderData.cryptoAmount.toString());
            console.log("   - reserved_amount:", orderData.reservedAmount.toString());
            console.log("   - remaining:", orderData.cryptoAmount.toNumber() - orderData.filledAmount.toNumber());
            throw new Error("Order should be closed but still exists");
        } catch (e: any) {
            if (e.message.includes("should be closed")) {
                throw e;
            }
            expect(e.message).to.include("Account does not exist");
            console.log("✓ Order closed");
        }

        try {
            await program.account.fillTicket.fetch(ticketPda);
            throw new Error("Ticket should be closed");
        } catch (e: any) {
            expect(e.message).to.include("Account does not exist");
            console.log("✓ Ticket closed");
        }

        try {
            await connection.getAccountInfo(vaultPda);
            const vaultInfo = await connection.getAccountInfo(vaultPda);
            if (vaultInfo !== null) {
                throw new Error("Vault should be closed");
            }
            console.log("✓ Vault closed");
        } catch (e: any) {
            if (e.message !== "Vault should be closed") {
                console.log("✓ Vault closed");
            } else {
                throw e;
            }
        }

        // Get admin SOL balance AFTER accounts closed
        const adminBalanceAfter = await connection.getBalance(adminSigner.publicKey);
        const rentRecovered = adminBalanceAfter - adminBalanceAfterLock;
        console.log("\n💰 Rent recovered:", (rentRecovered / 1_000_000_000).toFixed(5), "SOL");
        console.log("🏦 Admin SOL after close:", (adminBalanceAfter / 1_000_000_000).toFixed(5), "SOL");
        
        const netLoss = adminBalanceBefore - adminBalanceAfter;
        console.log("\n📊 NET LOSS (should be ~0):", (netLoss / 1_000_000_000).toFixed(5), "SOL");
        
        // Allow for small tx fees (~0.00001 SOL per tx = 3 txs = ~0.00003 SOL)
        const maxAcceptableLoss = 0.0001; // 0.0001 SOL tolerance for tx fees
        expect(netLoss / 1_000_000_000).to.be.lessThan(maxAcceptableLoss);
        
        console.log("✅ RENT FULLY RECOVERED! Admin only lost tx fees.");
        console.log("=".repeat(50) + "\n");
    });

    it.only("✅ SELL: full flow with dual signature → auto-close", async () => {
        const orderId = new anchor.BN(Date.now());
        const ticketId = new anchor.BN(1);
        const cryptoAmount = usdc(10);
        const fiatAmount = new anchor.BN(1000);

        console.log("📦 SELL: CryptoGuy accepts offer & locks");
        const beforeCrypto = await getTokenBalance(connection, cryptoGuyTokenAccount);
        
        const { orderPda, vaultPda, ticketPda } = await acceptOfferAndLock(
            program, orderId, ticketId, cryptoAmount, fiatAmount, true,
            cryptoGuy.publicKey, fiatGuy.publicKey, cryptoGuy,
            cryptoGuyTokenAccount, tokenSetup.mint, adminSigner
        );

        await waitForCooldown();

        const afterLock = await getTokenBalance(connection, cryptoGuyTokenAccount);
        const vaultBal = await getTokenBalance(connection, vaultPda);
        
        expect(beforeCrypto - afterLock).to.eq(cryptoAmount.toNumber());
        expect(vaultBal).to.eq(cryptoAmount.toNumber());
        console.log("✓ Locked:", vaultBal / 1_000_000, "USDC");

        console.log("✍️ FiatGuy signs");
        await signTicket(
            program, fiatGuy, orderPda, vaultPda, ticketPda,
            fiatGuyTokenAccount, adminTokenAccount, adminSigner
        );
        await waitForCooldown();

        console.log("✍️ CryptoGuy signs → settlement");
        const beforeFiat = await getTokenBalance(connection, fiatGuyTokenAccount);

        await signTicket(
            program, cryptoGuy, orderPda, vaultPda, ticketPda,
            fiatGuyTokenAccount, adminTokenAccount, adminSigner
        );

        await waitForCooldown();

        const afterFiat = await getTokenBalance(connection, fiatGuyTokenAccount);
        const fee = Math.floor(cryptoAmount.toNumber() * 20 / 10_000);
        expect(afterFiat - beforeFiat).to.eq(cryptoAmount.toNumber() - fee);
        console.log("✓ FiatGuy received:", (afterFiat - beforeFiat) / 1_000_000, "USDC");

        try {
            await program.account.universalOrder.fetch(orderPda);
            throw new Error("Should be closed");
        } catch (e: any) {
            expect(e.message).to.include("Account does not exist");
            console.log("✓ Auto-closed");
        }
    });

    it("✅ SELL: FiatGuy cancels → refund + auto-close", async () => {
        const orderId = new anchor.BN(Date.now() + 1);
        const ticketId = new anchor.BN(1);
        const cryptoAmount = usdc(5);
        const fiatAmount = new anchor.BN(500);

        console.log("\n📦 SELL: FiatGuy cancels");
        const balanceBefore = await logAdminBalance("Admin SOL before");

        const { orderPda, vaultPda, ticketPda } = await acceptOfferAndLock(
            program, orderId, ticketId, cryptoAmount, fiatAmount, true,
            cryptoGuy.publicKey, fiatGuy.publicKey, cryptoGuy,
            cryptoGuyTokenAccount, tokenSetup.mint, adminSigner
        );
        await waitForCooldown();

        const balanceAfterLock = await logAdminBalance("Admin SOL after lock");
        const rentPaid = balanceBefore - balanceAfterLock;
        console.log(`💸 Rent paid: ${(rentPaid / 1_000_000_000).toFixed(5)} SOL`);

        const beforeCrypto = await getTokenBalance(connection, cryptoGuyTokenAccount);

        await cancelTicket(
            program, fiatGuy, orderPda, vaultPda, ticketPda,
            cryptoGuyTokenAccount, adminSigner
        );
        await waitForCooldown();

        const afterCrypto = await getTokenBalance(connection, cryptoGuyTokenAccount);
        expect(afterCrypto - beforeCrypto).to.eq(cryptoAmount.toNumber());
        console.log("✓ Refunded:", (afterCrypto - beforeCrypto) / 1_000_000, "USDC");

        try {
            await program.account.universalOrder.fetch(orderPda);
            throw new Error("Should be closed");
        } catch (e: any) {
            expect(e.message).to.include("Account does not exist");
            console.log("✓ Auto-closed after cancel");
        }

        const balanceAfter = await logAdminBalance("Admin SOL after cancel");
        const rentRecovered = balanceAfter - balanceAfterLock;
        const netLoss = balanceBefore - balanceAfter;
        console.log(`💰 Rent recovered: ${(rentRecovered / 1_000_000_000).toFixed(5)} SOL`);
        console.log(`📊 NET LOSS: ${(netLoss / 1_000_000_000).toFixed(5)} SOL`);
        expect(netLoss / 1_000_000_000).to.be.lessThan(0.0001);
    });

    it.only("❌ SELL: CryptoGuy cannot cancel", async () => {
        const orderId = new anchor.BN(Date.now() + 2);
        const ticketId = new anchor.BN(1);
        const cryptoAmount = usdc(3);

        const { orderPda, vaultPda, ticketPda } = await acceptOfferAndLock(
            program, orderId, ticketId, cryptoAmount, new anchor.BN(300), true,
            cryptoGuy.publicKey, fiatGuy.publicKey, cryptoGuy,
            cryptoGuyTokenAccount, tokenSetup.mint, adminSigner
        );
        await waitForCooldown();

        try {
            await cancelTicket(
                program, cryptoGuy, orderPda, vaultPda, ticketPda,
                cryptoGuyTokenAccount, adminSigner
            );
            throw new Error("Should fail");
        } catch (e: any) {
            expect(e.message).to.include("Unauthorized");
            console.log("✓ CryptoGuy blocked from cancel");
        }

        await cancelTicket(
            program, fiatGuy, orderPda, vaultPda, ticketPda,
            cryptoGuyTokenAccount, adminSigner
        );
    });

    it.only("✅ BUY: full flow → auto-close", async () => {
        const orderId = new anchor.BN(Date.now() + 100);
        const ticketId = new anchor.BN(1);
        const cryptoAmount = usdc(8);

        console.log("📦 BUY: FiatGuy creates, CryptoGuy locks");

        const beforeCrypto = await getTokenBalance(connection, cryptoGuyTokenAccount);

        const { orderPda, vaultPda, ticketPda } = await acceptOfferAndLock(
            program, orderId, ticketId, cryptoAmount, new anchor.BN(800), false,
            fiatGuy.publicKey,      // creator - FiatGuy створює BUY offer (owner)
            cryptoGuy.publicKey,    // fiatGuy - CryptoGuy є acceptor (той хто приймає offer)
            cryptoGuy,              // cryptoGuy - CryptoGuy локає токени
            cryptoGuyTokenAccount, tokenSetup.mint, adminSigner
        );
        await waitForCooldown();

        const afterLock = await getTokenBalance(connection, cryptoGuyTokenAccount);
        expect(beforeCrypto - afterLock).to.eq(cryptoAmount.toNumber());
        console.log("✓ CryptoGuy locked:", (beforeCrypto - afterLock) / 1_000_000, "USDC");

        await signTicket(
            program, fiatGuy, orderPda, vaultPda, ticketPda,
            fiatGuyTokenAccount, adminTokenAccount, adminSigner
        );
        await waitForCooldown();

        const beforeFiat = await getTokenBalance(connection, fiatGuyTokenAccount);

        await signTicket(
            program, cryptoGuy, orderPda, vaultPda, ticketPda,
            fiatGuyTokenAccount, adminTokenAccount, adminSigner
        );
        await waitForCooldown();

        const afterFiat = await getTokenBalance(connection, fiatGuyTokenAccount);
        const fee = Math.floor(cryptoAmount.toNumber() * 20 / 10_000);
        expect(afterFiat - beforeFiat).to.eq(cryptoAmount.toNumber() - fee);
        console.log("✓ FiatGuy received:", (afterFiat - beforeFiat) / 1_000_000, "USDC");

        try {
            await program.account.universalOrder.fetch(orderPda);
            throw new Error("Should be closed");
        } catch (e: any) {
            expect(e.message).to.include("Account does not exist");
            console.log("✓ BUY auto-closed");
        }
    });

    it("✅ Admin payout SELL → auto-close", async () => {
        const orderId = new anchor.BN(Date.now() + 200);
        const ticketId = new anchor.BN(1);
        const cryptoAmount = usdc(6);

        console.log("\n📦 Admin payout SELL");
        const balanceBefore = await logAdminBalance("Admin SOL before");

        const { orderPda, vaultPda, ticketPda } = await acceptOfferAndLock(
            program, orderId, ticketId, cryptoAmount, new anchor.BN(600), true,
            cryptoGuy.publicKey, fiatGuy.publicKey, cryptoGuy,
            cryptoGuyTokenAccount, tokenSetup.mint, adminSigner
        );
        await waitForCooldown();

        const balanceAfterLock = await logAdminBalance("Admin SOL after lock");
        const rentPaid = balanceBefore - balanceAfterLock;
        console.log(`💸 Rent paid: ${(rentPaid / 1_000_000_000).toFixed(5)} SOL`);

        const beforeFiat = await getTokenBalance(connection, fiatGuyTokenAccount);
        const ticketData = await program.account.fillTicket.fetch(ticketPda);

        await (program.methods as any)
            .adminResolveUniversalTicket(true)
            .accounts({
                admin: adminSigner.publicKey,
                adminRentReceiver: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptor: ticketData.acceptor,
                fiatGuyTokenAccount: fiatGuyTokenAccount,
                cryptoGuyTokenAccount: cryptoGuyTokenAccount,
                adminFeeAccount: adminTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([adminSigner])
            .rpc();
        await waitForCooldown();

        const afterFiat = await getTokenBalance(connection, fiatGuyTokenAccount);
        const fee = Math.floor(cryptoAmount.toNumber() * 20 / 10_000);
        expect(afterFiat - beforeFiat).to.eq(cryptoAmount.toNumber() - fee);
        console.log("✓ Admin payout:", (afterFiat - beforeFiat) / 1_000_000, "USDC");

        try {
            await program.account.universalOrder.fetch(orderPda);
            throw new Error("Should be closed");
        } catch (e: any) {
            expect(e.message).to.include("Account does not exist");
            console.log("✓ Auto-closed after admin payout");
        }

        const balanceAfter = await logAdminBalance("Admin SOL after payout");
        const rentRecovered = balanceAfter - balanceAfterLock;
        const netLoss = balanceBefore - balanceAfter;
        console.log(`💰 Rent recovered: ${(rentRecovered / 1_000_000_000).toFixed(5)} SOL`);
        console.log(`📊 NET LOSS: ${(netLoss / 1_000_000_000).toFixed(5)} SOL`);
        expect(netLoss / 1_000_000_000).to.be.lessThan(0.0001);
    });

    it("✅ Admin refund SELL → auto-close", async () => {
        const orderId = new anchor.BN(Date.now() + 201);
        const ticketId = new anchor.BN(1);
        const cryptoAmount = usdc(4);

        console.log("\n📦 Admin refund SELL");
        const balanceBefore = await logAdminBalance("Admin SOL before");

        const { orderPda, vaultPda, ticketPda } = await acceptOfferAndLock(
            program, orderId, ticketId, cryptoAmount, new anchor.BN(400), true,
            cryptoGuy.publicKey, fiatGuy.publicKey, cryptoGuy,
            cryptoGuyTokenAccount, tokenSetup.mint, adminSigner
        );
        await waitForCooldown();

        const balanceAfterLock = await logAdminBalance("Admin SOL after lock");
        const rentPaid = balanceBefore - balanceAfterLock;
        console.log(`💸 Rent paid: ${(rentPaid / 1_000_000_000).toFixed(5)} SOL`);

        const beforeCrypto = await getTokenBalance(connection, cryptoGuyTokenAccount);
        const ticketData = await program.account.fillTicket.fetch(ticketPda);

        await (program.methods as any)
            .adminResolveUniversalTicket(false)
            .accounts({
                admin: adminSigner.publicKey,
                adminRentReceiver: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptor: ticketData.acceptor,
                fiatGuyTokenAccount: fiatGuyTokenAccount,
                cryptoGuyTokenAccount: cryptoGuyTokenAccount,
                adminFeeAccount: adminTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([adminSigner])
            .rpc();
        await waitForCooldown();

        const afterCrypto = await getTokenBalance(connection, cryptoGuyTokenAccount);
        expect(afterCrypto - beforeCrypto).to.eq(cryptoAmount.toNumber());
        console.log("✓ Admin refund:", (afterCrypto - beforeCrypto) / 1_000_000, "USDC");

        try {
            await program.account.universalOrder.fetch(orderPda);
            throw new Error("Should be closed");
        } catch (e: any) {
            expect(e.message).to.include("Account does not exist");
            console.log("✓ Auto-closed after admin refund");
        }

        const balanceAfter = await logAdminBalance("Admin SOL after refund");
        const rentRecovered = balanceAfter - balanceAfterLock;
        const netLoss = balanceBefore - balanceAfter;
        console.log(`💰 Rent recovered: ${(rentRecovered / 1_000_000_000).toFixed(5)} SOL`);
        console.log(`📊 NET LOSS: ${(netLoss / 1_000_000_000).toFixed(5)} SOL`);
        expect(netLoss / 1_000_000_000).to.be.lessThan(0.0001);
    });
});
