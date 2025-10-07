import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, Transaction, SendTransactionError  } from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID,
    getOrCreateAssociatedTokenAccount,
    transfer,
} from "@solana/spl-token";
import bs58 from "bs58";
import {expect} from "chai";
import { Ddd } from "../target/types/ddd";
import { 
    setupTestEnvironment, 
    TestTokenSetup, 
    TEST_TOKEN_AMOUNT_10,
    TEST_TOKEN_AMOUNT_100,
    getTokenBalance,
    mintMoreTokens
} from "../utils/testTokens";
import { 
    checkDonorBalance, 
} from "../utils/solFunder";
import { setupAnchorEnvironment, sleep, waitForCooldown, TEST_WALLETS } from "../utils/testConfig";

describe.only("🧪 Universal Orders: basic create", () => {
    const { connection, provider, program } = setupAnchorEnvironment();

    let tokenSetup: TestTokenSetup;
    let cryptoGuy: Keypair;
    let fiatGuy: Keypair;
    let cryptoGuyTokenAccount: PublicKey;
    let fiatGuyTokenAccount: PublicKey;
    let adminTokenAccount: PublicKey; 
    const adminSigner = TEST_WALLETS.buyer; 

    const DECIMALS = 6;
    const TEN_TOKENS = TEST_TOKEN_AMOUNT_10;

    before("setup token mint and users", async () => {
        await checkDonorBalance(connection);

        cryptoGuy = Keypair.generate();
        fiatGuy   = Keypair.generate();

        const env = await setupTestEnvironment(
            connection,
            provider.wallet.payer as Keypair,
            [cryptoGuy, fiatGuy],
            TEST_TOKEN_AMOUNT_100, // 100 tokens to each
            DECIMALS,
        );
        tokenSetup = env.tokenSetup;
        cryptoGuyTokenAccount = env.userAccounts[0].tokenAccount;
        fiatGuyTokenAccount   = env.userAccounts[1].tokenAccount;

        // Create admin token account for fees
        const adminAtaInfo = await getOrCreateAssociatedTokenAccount(
            connection,
            provider.wallet.payer as Keypair,
            tokenSetup.mint,
            provider.wallet.publicKey
        );
        adminTokenAccount = adminAtaInfo.address;
    });
    // Always try to return remaining tokens to the main (provider) wallet
    after("return test tokens to main wallet", async function () {
        this.timeout(30000);
        try {
            if (!tokenSetup) return;
            const payer = provider.wallet.payer as Keypair;
            const mainAtaInfo = await getOrCreateAssociatedTokenAccount(
                connection,
                payer,
                tokenSetup.mint,
                payer.publicKey
            );
            const mainAta = mainAtaInfo.address;

            const users = [
                { label: "CryptoGuy", owner: cryptoGuy, ata: cryptoGuyTokenAccount },
                { label: "FiatGuy",   owner: fiatGuy,   ata: fiatGuyTokenAccount },
            ];

            for (const u of users) {
                try {
                    const bal = await getTokenBalance(connection, u.ata);
                    if (bal > 0) {
                        await transfer(
                            connection,
                            payer,             // payer for fees
                            u.ata,             // source (user ATA)
                            mainAta,           // destination (provider ATA)
                            u.owner,           // owner of source ATA
                            bal                 // move all remaining tokens
                        );
                    }
                } catch (e) {
                    console.warn(`⚠️ Token return from ${u.label} failed:`, (e as any)?.message || e);
                }
            }
        } catch (e) {
            console.warn("⚠️ Token return cleanup encountered an error:", (e as any)?.message || e);
        }
    });

    it("creates Sell order (CryptoGuy) and locks tokens into vault", async () => {
        const orderId = new anchor.BN(Date.now());

        const orderSeed = Buffer.from("universal_order");
        const vaultSeed = Buffer.from("vault");
        const orderIdBuf = orderId.toArrayLike(Buffer, "le", 8);

        const [orderPda] = PublicKey.findProgramAddressSync(
            [orderSeed, cryptoGuy.publicKey.toBuffer(), tokenSetup.mint.toBuffer(), orderIdBuf],
            program.programId,
        );
        const [vaultPda] = PublicKey.findProgramAddressSync(
            [vaultSeed, orderPda.toBuffer()],
            program.programId,
        );

        const beforeCreatorBal = await getTokenBalance(connection, cryptoGuyTokenAccount);

        const sig = await (program.methods as any)
            .createUniversalOrder(
                orderId,
                new anchor.BN(TEN_TOKENS),      // crypto_amount = 10 tokens
                new anchor.BN(1_000),           // fiat_amount dummy
                true                             // is_sell_order
            )
            .accounts({
                creator: cryptoGuy.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: cryptoGuyTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([cryptoGuy, adminSigner])
            .rpc();

        // Fetch order and balances
        const orderAcc = await program.account.universalOrder.fetch(orderPda);
        const vaultBal = await getTokenBalance(connection, vaultPda);
        const afterCreatorBal = await getTokenBalance(connection, cryptoGuyTokenAccount);

        // Assertions
        expect(orderAcc.creator.equals(cryptoGuy.publicKey)).to.be.true;
        expect(orderAcc.isSellOrder).to.eq(true);
        expect(Number(orderAcc.cryptoAmount)).to.eq(TEN_TOKENS);
        expect(orderAcc.vault.equals(vaultPda)).to.be.true;

        expect(vaultBal).to.eq(TEN_TOKENS); // 10 tokens locked in vault
        expect(beforeCreatorBal - afterCreatorBal).to.eq(TEN_TOKENS);
    });

    it("creates Buy order (FiatGuy) without locking tokens", async () => {
        const orderId = new anchor.BN(Date.now() + 1);

        const orderSeed = Buffer.from("universal_order");
        const vaultSeed = Buffer.from("vault");
        const orderIdBuf = orderId.toArrayLike(Buffer, "le", 8);

        const [orderPda] = PublicKey.findProgramAddressSync(
            [orderSeed, fiatGuy.publicKey.toBuffer(), tokenSetup.mint.toBuffer(), orderIdBuf],
            program.programId,
        );
        const [vaultPda] = PublicKey.findProgramAddressSync(
            [vaultSeed, orderPda.toBuffer()],
            program.programId,
        );

        const beforeFiatBal = await getTokenBalance(connection, fiatGuyTokenAccount);

        const sig = await (program.methods as any)
            .createUniversalOrder(
                orderId,
                new anchor.BN(TEN_TOKENS),     // request to buy 10 tokens
                new anchor.BN(2_000),          // fiat reference
                false                           // is_sell_order = false (Buy order)
            )
            .accounts({
                creator: fiatGuy.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                // Anchor requires this account to be present even for Buy orders (unused)
                creatorTokenAccount: fiatGuyTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([fiatGuy, adminSigner])
            .rpc();

        const orderAcc = await program.account.universalOrder.fetch(orderPda);
        const vaultBal = await getTokenBalance(connection, vaultPda);
        const afterFiatBal = await getTokenBalance(connection, fiatGuyTokenAccount);

        expect(orderAcc.creator.equals(fiatGuy.publicKey)).to.be.true;
        expect(orderAcc.isSellOrder).to.eq(false);
        expect(Number(orderAcc.cryptoAmount)).to.eq(TEN_TOKENS);

        // Buy order does not lock tokens on create
        expect(vaultBal).to.eq(0);
        expect(afterFiatBal).to.eq(beforeFiatBal);
    });
  
});

describe("🛑 Universal Orders: cancel rules — Sell owner (CryptoGuy)", () => {
    const { connection, provider, program } = setupAnchorEnvironment();
    const toBN = (n: number) => new anchor.BN(n);
    const usdc = (n: number) => new anchor.BN(Math.round(n * 1_000_000));

    type Party = { kp: Keypair; ata: PublicKey };

    let tokenSetup: TestTokenSetup;
    let cryptoGuy: Party;
    let fiatGuy: Party;
    let orderPda: PublicKey;
    let vaultPda: PublicKey;
    let adminTokenAccount: PublicKey;
    const adminSigner = TEST_WALLETS.buyer; // from utils/testConfig

    before("setup mint + users", async () => {
        await checkDonorBalance(connection);
        const seller = Keypair.generate();
        const buyer = Keypair.generate();
        const env = await setupTestEnvironment(
            connection,
            provider.wallet.payer as Keypair,
            [seller, buyer],
            // Mint more to the seller because multiple tests in this suite lock tokens without freeing them
            TEST_TOKEN_AMOUNT_100 * 5,
            6
        );
        tokenSetup = env.tokenSetup;
        cryptoGuy = { kp: seller, ata: env.userAccounts[0].tokenAccount };
        fiatGuy   = { kp: buyer,  ata: env.userAccounts[1].tokenAccount };

        // Admin fee ATA (owned by hardcoded admin); provider pays rent if missing
        const adminAtaInfo = await getOrCreateAssociatedTokenAccount(
            connection,
            provider.wallet.payer as Keypair,
            tokenSetup.mint,
            adminSigner.publicKey
        );
        adminTokenAccount = adminAtaInfo.address;
    });

    const deriveOrder = (orderId: anchor.BN) => {
        const orderSeed = Buffer.from("universal_order");
        const vaultSeed = Buffer.from("vault");
        const orderIdBuf = orderId.toArrayLike(Buffer, "le", 8);
        const [o] = PublicKey.findProgramAddressSync(
            [orderSeed, cryptoGuy.kp.publicKey.toBuffer(), tokenSetup.mint.toBuffer(), orderIdBuf],
            program.programId,
        );
        const [v] = PublicKey.findProgramAddressSync(
            [vaultSeed, o.toBuffer()],
            program.programId,
        );
        return { o, v };
    };

    const ticketPdaFor = (order: PublicKey, id: number) =>
        PublicKey.findProgramAddressSync([
            Buffer.from("ticket"), order.toBuffer(), toBN(id).toArrayLike(Buffer, "le", 8)
        ], program.programId)[0];

    it("1) After FiatGuy signed ticket, neither side can cancel ticket; order cancel fails when fully reserved", async () => {
        const orderId = toBN(Date.now() + 2001);
        ({ o: orderPda, v: vaultPda } = deriveOrder(orderId));

        // Create Sell order 100
        await (program.methods as any)
            .createUniversalOrder(orderId, usdc(100), toBN(1_000), true)
            .accounts({
                creator: cryptoGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: cryptoGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([cryptoGuy.kp, adminSigner])
            .rpc();

        await waitForCooldown();

        // FiatGuy accepts FULL amount
        const ticketId = 1;
        const ticketPda = ticketPdaFor(orderPda, ticketId);
        await (program.methods as any)
            .acceptUniversalTicket(toBN(ticketId), usdc(100))
            .accounts({
                acceptor: fiatGuy.kp.publicKey,
                feePayer: adminSigner.publicKey, // Admin pays rent
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([fiatGuy.kp, adminSigner])
            .rpc();

        await waitForCooldown();

        // FiatGuy signs (marks fiat sent); not both signed
        const ticketData1 = await program.account.fillTicket.fetch(ticketPda);
        await (program.methods as any)
            .signUniversalTicket()
            .accounts({
                signer: fiatGuy.kp.publicKey,
                adminRentReceiver: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                fiatGuyTokenAccount: fiatGuy.ata,
                adminFeeAccount: adminTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([fiatGuy.kp])
            .rpc();

        // Attempt order cancel by CryptoGuy -> should fail because remaining == reserved (releasable=0)
        try {
            await (program.methods as any)
                .cancelUniversalOrder()
                .accounts({
                    creator: cryptoGuy.kp.publicKey,
                    order: orderPda,
                    vault: vaultPda,
                    creatorTokenAccount: cryptoGuy.ata,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([cryptoGuy.kp])
                .rpc();
            expect.fail("Order cancel should fail when fully reserved after fiat sign");
        } catch (e: any) {
            const logs = e?.logs?.join("\n") || "";
            expect(e.message.includes("CannotCancel") || logs.includes("CannotCancel")).to.eq(true);
        }

        // FiatGuy cannot cancel his ticket after he signed
        try {
            const ticketDataCancel1 = await program.account.fillTicket.fetch(ticketPda);
            await (program.methods as any)
                .cancelUniversalTicket()
                .accounts({
                    canceller: fiatGuy.kp.publicKey,
                    adminRentReceiver: adminSigner.publicKey,
                    order: orderPda,
                    vault: vaultPda,
                    ticket: ticketPda,
                    acceptorTokenAccount: fiatGuy.ata,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([fiatGuy.kp])
                .rpc();
            expect.fail("FiatGuy cancel ticket should fail after fiat sign");
        } catch (e: any) {
            const logs = e?.logs?.join("\n") || "";
            expect(e.message.includes("CannotCancel") || logs.includes("CannotCancel")).to.eq(true);
        }

        // CryptoGuy cannot cancel the ticket either after fiat sign
        try {
            const ticketDataCancel2 = await program.account.fillTicket.fetch(ticketPda);
            await (program.methods as any)
                .cancelUniversalTicket()
                .accounts({
                    canceller: cryptoGuy.kp.publicKey,
                    adminRentReceiver: adminSigner.publicKey,
                    order: orderPda,
                    vault: vaultPda,
                    ticket: ticketPda,
                    acceptorTokenAccount: fiatGuy.ata,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([cryptoGuy.kp])
                .rpc();
            expect.fail("CryptoGuy cancel ticket should fail after fiat sign");
        } catch (e: any) {
            const logs = e?.logs?.join("\n") || "";
            expect(e.message.includes("CannotCancel") || logs.includes("CannotCancel")).to.eq(true);
        }
    });

    it("2) If there are no active reservations, seller can cancel remainder and receive tokens back", async () => {
        const orderId = toBN(Date.now() + 2002);
        ({ o: orderPda, v: vaultPda } = deriveOrder(orderId));

        // Ensure seller has enough tokens for this scenario
        const sellerBal = await getTokenBalance(connection, cryptoGuy.ata);
        if (sellerBal < usdc(100).toNumber()) {
            await mintMoreTokens(connection, provider.wallet.payer as Keypair, cryptoGuy.ata, tokenSetup, usdc(150).toNumber());
        }

        // Create Sell order 100
        await (program.methods as any)
            .createUniversalOrder(orderId, usdc(100), toBN(1_000), true)
            .accounts({
                creator: cryptoGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: cryptoGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([cryptoGuy.kp, adminSigner])
            .rpc();

        await waitForCooldown();

        // FiatGuy accepts and both sign for 50 -> settle
        const ticketId = 2;
        const ticketPda = ticketPdaFor(orderPda, ticketId);
        await (program.methods as any)
            .acceptUniversalTicket(toBN(ticketId), usdc(50))
            .accounts({
                acceptor: fiatGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([fiatGuy.kp, adminSigner])
            .rpc();

        await waitForCooldown();
        // Both sign -> settle
        const ticketData2 = await program.account.fillTicket.fetch(ticketPda);
        await (program.methods as any)
            .signUniversalTicket()
            .accounts({ 
                signer: fiatGuy.kp.publicKey, 
                adminRentReceiver: adminSigner.publicKey,
                order: orderPda, 
                vault: vaultPda, 
                ticket: ticketPda, 
                fiatGuyTokenAccount: fiatGuy.ata,
                adminFeeAccount: adminTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID 
            })
            .signers([fiatGuy.kp]).rpc();
        await (program.methods as any)
            .signUniversalTicket()
            .accounts({ 
                signer: cryptoGuy.kp.publicKey, 
                adminRentReceiver: adminSigner.publicKey,
                order: orderPda, 
                vault: vaultPda, 
                ticket: ticketPda, 
                fiatGuyTokenAccount: fiatGuy.ata,
                adminFeeAccount: adminTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID 
            })
            .signers([cryptoGuy.kp]).rpc();

        // Now reserved = 0, remaining = 50 -> seller can cancel remainder
        const before = await getTokenBalance(connection, cryptoGuy.ata);
        await (program.methods as any)
            .cancelUniversalOrder()
            .accounts({
                creator: cryptoGuy.kp.publicKey,
                order: orderPda,
                vault: vaultPda,
                creatorTokenAccount: cryptoGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([cryptoGuy.kp])
            .rpc();
        const after = await getTokenBalance(connection, cryptoGuy.ata);
        expect(after - before).to.eq(usdc(50).toNumber());
    });

    it("4) CryptoGuy can cancel a ticket only before FiatGuy signs", async () => {
        const orderId = toBN(Date.now() + 2003);
        ({ o: orderPda, v: vaultPda } = deriveOrder(orderId));

        // Ensure seller has enough tokens for this scenario
        const sellerBal = await getTokenBalance(connection, cryptoGuy.ata);
        if (sellerBal < usdc(20).toNumber()) {
            await mintMoreTokens(connection, provider.wallet.payer as Keypair, cryptoGuy.ata, tokenSetup, usdc(50).toNumber());
        }

        await (program.methods as any)
            .createUniversalOrder(orderId, usdc(20), toBN(1_000), true)
            .accounts({
                creator: cryptoGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: cryptoGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([cryptoGuy.kp, adminSigner])
            .rpc();

        await waitForCooldown();
        const ticketId = 3;
        const ticketPda = ticketPdaFor(orderPda, ticketId);
        await (program.methods as any)
            .acceptUniversalTicket(toBN(ticketId), usdc(10))
            .accounts({
                acceptor: fiatGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([fiatGuy.kp, adminSigner])
            .rpc();

        await waitForCooldown();

        // CryptoGuy cancels the ticket (FiatGuy hasn't signed yet)
        const ticketDataCancel3 = await program.account.fillTicket.fetch(ticketPda);
        await (program.methods as any)
            .cancelUniversalTicket()
            .accounts({
                canceller: cryptoGuy.kp.publicKey,
                adminRentReceiver: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptor: ticketDataCancel3.acceptor,
                acceptorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([cryptoGuy.kp])
            .rpc();
    });
});


describe("👑 Universal Orders: admin resolve (ticket-level)", () => {
    const { connection, provider, program } = setupAnchorEnvironment();

    const toBN = (n: number) => new anchor.BN(n);
    const usdc = (n: number) => new anchor.BN(Math.round(n * 1_000_000));

    type Party = { kp: Keypair; ata: PublicKey };

    let tokenSetup: TestTokenSetup;
    let cryptoGuy: Party;
    let fiatGuy: Party;
    let adminTokenAccount: PublicKey;
    // Use the admin keypair from ENV config
    const adminSigner = TEST_WALLETS.buyer;

    before("setup fresh mint + users for admin suite", async () => {
        await checkDonorBalance(connection);
        const seller = Keypair.generate();
        const buyer = Keypair.generate();
        const env = await setupTestEnvironment(
            connection,
            provider.wallet.payer as Keypair,
            [seller, buyer],
            TEST_TOKEN_AMOUNT_100,
            6
        );
        tokenSetup = env.tokenSetup;
        cryptoGuy = { kp: seller, ata: env.userAccounts[0].tokenAccount };
        fiatGuy   = { kp: buyer,  ata: env.userAccounts[1].tokenAccount };

        // Ensure admin signer has enough SOL for fees
        const minLamports = 200_000_000; // 0.2 SOL
        const current = await connection.getBalance(adminSigner.publicKey);
        if (current < minLamports) {
            const shortfall = minLamports - current + 50_000_000; // pad +0.05 SOL
            const tx = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: provider.wallet.publicKey,
                    toPubkey: adminSigner.publicKey,
                    lamports: shortfall,
                })
            );
            await provider.sendAndConfirm(tx, [provider.wallet.payer as Keypair]);
        }
        const funded = await connection.getBalance(adminSigner.publicKey);
        console.log("👑 Admin signer:", adminSigner.publicKey.toBase58(), "| Balance:", funded / 1_000_000_000, "SOL");

        // Prepare admin fee ATA for this mint (owned by admin)
        const adminAtaInfo = await getOrCreateAssociatedTokenAccount(
            connection,
            provider.wallet.payer as Keypair,
            tokenSetup.mint,
            adminSigner.publicKey
        );
        adminTokenAccount = adminAtaInfo.address;
    });

    const deriveOrderAndVault = (creator: PublicKey, orderId: anchor.BN) => {
        const orderSeed = Buffer.from("universal_order");
        const vaultSeed = Buffer.from("vault");
        const orderIdBuf = orderId.toArrayLike(Buffer, "le", 8);
        const [orderPda] = PublicKey.findProgramAddressSync(
            [orderSeed, creator.toBuffer(), tokenSetup.mint.toBuffer(), orderIdBuf],
            program.programId,
        );
        const [vaultPda] = PublicKey.findProgramAddressSync(
            [vaultSeed, orderPda.toBuffer()],
            program.programId,
        );
        return { orderPda, vaultPda };
    };

    const ticketPdaFor = (order: PublicKey, id: number) =>
        PublicKey.findProgramAddressSync([
            Buffer.from("ticket"), order.toBuffer(), new anchor.BN(id).toArrayLike(Buffer, "le", 8)
        ], program.programId)[0];

    it("Sell: admin releases ticket to FiatGuy (payout)", async () => {
        const total = usdc(12);
        const fill  = usdc(4);
        const orderId = toBN(Date.now() + 9001);
        const { orderPda, vaultPda } = deriveOrderAndVault(cryptoGuy.kp.publicKey, orderId);

        // Ensure seller balance sufficient to lock
        const sellerBal = await getTokenBalance(connection, cryptoGuy.ata);
        if (sellerBal < total.toNumber()) {
            await mintMoreTokens(connection, provider.wallet.payer as Keypair, cryptoGuy.ata, tokenSetup, total.toNumber());
        }

        await (program.methods as any)
            .createUniversalOrder(orderId, total, toBN(1_000), true)
            .accounts({
                creator: cryptoGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: cryptoGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([cryptoGuy.kp, adminSigner])
            .rpc();

        await waitForCooldown();

        const ticketId = 1;
        const ticketPda = ticketPdaFor(orderPda, ticketId);
        await (program.methods as any) 
            .acceptUniversalTicket(new anchor.BN(ticketId), fill)
            .accounts({
                acceptor: fiatGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([fiatGuy.kp, adminSigner])
            .rpc();

    const fiatBefore = await getTokenBalance(connection, fiatGuy.ata);
    const vaultBefore = await getTokenBalance(connection, vaultPda);
    console.log("➡️ Admin (", adminSigner.publicKey.toBase58(), ") resolving payout to FiatGuy. Before → fiat:", fiatBefore / 1_000_000, "vault:", vaultBefore / 1_000_000);

        // Fetch ticket to get acceptor
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
                fiatGuyTokenAccount: fiatGuy.ata,
                cryptoGuyTokenAccount: cryptoGuy.ata,
                adminFeeAccount: adminTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([adminSigner])
            .rpc();

    const fiatAfter = await getTokenBalance(connection, fiatGuy.ata);
    const vaultAfter = await getTokenBalance(connection, vaultPda);
    console.log("✅ After resolve → fiat:", fiatAfter / 1_000_000, "vault:", vaultAfter / 1_000_000, "moved:", (fiatAfter - fiatBefore) / 1_000_000, "tokens");
        const fee = Math.floor(fill.toNumber() * 20 / 10_000);
        expect(fiatAfter - fiatBefore).to.eq(fill.toNumber() - fee);
        expect(vaultBefore - vaultAfter).to.eq(fill.toNumber());

        const orderAcc = await program.account.universalOrder.fetch(orderPda);
        expect(Number(orderAcc.filledAmount)).to.eq(fill.toNumber());
        expect(Number(orderAcc.reservedAmount)).to.eq(0);
    });

    it("Sell: admin refunds ticket back to CryptoGuy (refund)", async () => {
        const total = usdc(12);
        const fill  = usdc(4);
        const orderId = toBN(Date.now() + 9002);
        const { orderPda, vaultPda } = deriveOrderAndVault(cryptoGuy.kp.publicKey, orderId);

        const sellerBal = await getTokenBalance(connection, cryptoGuy.ata);
        if (sellerBal < total.toNumber()) {
            await mintMoreTokens(connection, provider.wallet.payer as Keypair, cryptoGuy.ata, tokenSetup, total.toNumber());
        }

        await (program.methods as any)
            .createUniversalOrder(orderId, total, toBN(1_000), true)
            .accounts({
                creator: cryptoGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: cryptoGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([cryptoGuy.kp, adminSigner])
            .rpc();

        await waitForCooldown();

        const ticketId = 1;
        const ticketPda = ticketPdaFor(orderPda, ticketId);
        await (program.methods as any)
            .acceptUniversalTicket(new anchor.BN(ticketId), fill)
            .accounts({
                acceptor: fiatGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([fiatGuy.kp, adminSigner])
            .rpc();

    const sellerBefore = await getTokenBalance(connection, cryptoGuy.ata);
    const vaultBefore = await getTokenBalance(connection, vaultPda);
    console.log("➡️ Admin (", adminSigner.publicKey.toBase58(), ") resolving REFUND to CryptoGuy. Before → seller:", sellerBefore / 1_000_000, "vault:", vaultBefore / 1_000_000);

        // Fetch ticket to get acceptor
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
                cryptoGuyTokenAccount: cryptoGuy.ata,
                fiatGuyTokenAccount: fiatGuy.ata,
                adminFeeAccount: adminTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([adminSigner])
            .rpc();

    const sellerAfter = await getTokenBalance(connection, cryptoGuy.ata);
    const vaultAfter = await getTokenBalance(connection, vaultPda);
    console.log("✅ After resolve → seller:", sellerAfter / 1_000_000, "vault:", vaultAfter / 1_000_000, "moved:", (sellerAfter - sellerBefore) / 1_000_000, "tokens");
    // Refund case: assume no fee on refund
    expect(sellerAfter - sellerBefore).to.eq(fill.toNumber());
        expect(vaultBefore - vaultAfter).to.eq(fill.toNumber());

        const orderAcc = await program.account.universalOrder.fetch(orderPda);
        expect(Number(orderAcc.reservedAmount)).to.eq(0);
        expect(Number(orderAcc.cryptoAmount)).to.eq(total.sub(fill).toNumber());
    });

    it("Buy: admin releases ticket to FiatGuy (payout)", async () => {
        const total = usdc(12);
        const fill  = usdc(4);
        const orderId = toBN(Date.now() + 9003);
        const { orderPda, vaultPda } = deriveOrderAndVault(fiatGuy.kp.publicKey, orderId);

        await (program.methods as any)
            .createUniversalOrder(orderId, total, toBN(2_000), false)
            .accounts({
                creator: fiatGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([fiatGuy.kp, adminSigner])
            .rpc();

        await waitForCooldown();

        const ticketId = 1;
        const ticketPda = ticketPdaFor(orderPda, ticketId);
        const sellerBefore = await getTokenBalance(connection, cryptoGuy.ata);
        await (program.methods as any)
            .acceptUniversalTicket(new anchor.BN(ticketId), fill)
            .accounts({
                acceptor: cryptoGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptorTokenAccount: cryptoGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([cryptoGuy.kp, adminSigner])
            .rpc();

    const fiatBefore = await getTokenBalance(connection, fiatGuy.ata);
    const vaultBefore = await getTokenBalance(connection, vaultPda);
    console.log("➡️ Admin (", adminSigner.publicKey.toBase58(), ") resolving payout to FiatGuy (Buy order). Before → fiat:", fiatBefore / 1_000_000, "vault:", vaultBefore / 1_000_000);

        // Fetch ticket to get acceptor
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
                fiatGuyTokenAccount: fiatGuy.ata,
                cryptoGuyTokenAccount: cryptoGuy.ata,
                adminFeeAccount: adminTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([adminSigner])
            .rpc();

    const fiatAfter = await getTokenBalance(connection, fiatGuy.ata);
    const vaultAfter = await getTokenBalance(connection, vaultPda);
    console.log("✅ After resolve → fiat:", fiatAfter / 1_000_000, "vault:", vaultAfter / 1_000_000, "moved:", (fiatAfter - fiatBefore) / 1_000_000, "tokens");
    const fee2 = Math.floor(fill.toNumber() * 20 / 10_000);
    expect(fiatAfter - fiatBefore).to.eq(fill.toNumber() - fee2);
        expect(vaultBefore - vaultAfter).to.eq(fill.toNumber());

        const orderAcc = await program.account.universalOrder.fetch(orderPda);
        expect(Number(orderAcc.filledAmount)).to.eq(fill.toNumber());
        expect(Number(orderAcc.reservedAmount)).to.eq(0);
    });

    it("Buy: admin refunds ticket back to CryptoGuy (refund)", async () => {
        const total = usdc(12);
        const fill  = usdc(4);
        const orderId = toBN(Date.now() + 9004);
        const { orderPda, vaultPda } = deriveOrderAndVault(fiatGuy.kp.publicKey, orderId);

        await (program.methods as any)
            .createUniversalOrder(orderId, total, toBN(2_000), false)
            .accounts({
                creator: fiatGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([fiatGuy.kp, adminSigner])
            .rpc();

        await waitForCooldown();

        const ticketId = 1;
        const ticketPda = ticketPdaFor(orderPda, ticketId);
        await (program.methods as any)
            .acceptUniversalTicket(new anchor.BN(ticketId), fill)
            .accounts({
                acceptor: cryptoGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptorTokenAccount: cryptoGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([cryptoGuy.kp, adminSigner])
            .rpc();

    const sellerBefore = await getTokenBalance(connection, cryptoGuy.ata);
    const vaultBefore = await getTokenBalance(connection, vaultPda);
    console.log("➡️ Admin (", adminSigner.publicKey.toBase58(), ") resolving REFUND to CryptoGuy (Buy order). Before → seller:", sellerBefore / 1_000_000, "vault:", vaultBefore / 1_000_000);

        // Fetch ticket to get acceptor
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
                cryptoGuyTokenAccount: cryptoGuy.ata,
                fiatGuyTokenAccount: fiatGuy.ata,
                adminFeeAccount: adminTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([adminSigner])
            .rpc();

    const sellerAfter = await getTokenBalance(connection, cryptoGuy.ata);
    const vaultAfter = await getTokenBalance(connection, vaultPda);
    console.log("✅ After resolve → seller:", sellerAfter / 1_000_000, "vault:", vaultAfter / 1_000_000, "moved:", (sellerAfter - sellerBefore) / 1_000_000, "tokens");
    // Refund case: assume no fee on refund
    expect(sellerAfter - sellerBefore).to.eq(fill.toNumber());
        expect(vaultBefore - vaultAfter).to.eq(fill.toNumber());

        const orderAcc = await program.account.universalOrder.fetch(orderPda);
        expect(Number(orderAcc.reservedAmount)).to.eq(0);
    });

    it("Admin can't send to stranger ATA (invalid destination)", async () => {
        console.log("👑 Using admin:", adminSigner.publicKey.toBase58(), "for stranger-ATA negative test");
        // Setup minimal Sell with a small ticket
        const total = usdc(12);
        const fill  = usdc(4);
        const orderId = toBN(Date.now() + 9005);
        const { orderPda, vaultPda } = deriveOrderAndVault(cryptoGuy.kp.publicKey, orderId);

        // Ensure seller has enough tokens
        const sellerBal = await getTokenBalance(connection, cryptoGuy.ata);
        if (sellerBal < total.toNumber()) {
            await mintMoreTokens(connection, provider.wallet.payer as Keypair, cryptoGuy.ata, tokenSetup, total.toNumber());
        }

        await (program.methods as any)
            .createUniversalOrder(orderId, total, toBN(1_000), true)
            .accounts({
                creator: cryptoGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: cryptoGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([cryptoGuy.kp, adminSigner])
            .rpc();

        await waitForCooldown();

        const ticketId = 1;
        const ticketPda = ticketPdaFor(orderPda, ticketId);
        await (program.methods as any)
            .acceptUniversalTicket(new anchor.BN(ticketId), fill)
            .accounts({
                acceptor: fiatGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([fiatGuy.kp, adminSigner])
            .rpc();

        // Create a stranger ATA with same mint
        const stranger = Keypair.generate();
        const { getOrCreateAssociatedTokenAccount } = await import("@solana/spl-token");
        const strangerAta = await getOrCreateAssociatedTokenAccount(
            connection,
            provider.wallet.payer as Keypair,
            tokenSetup.mint,
            stranger.publicKey
        );

        // Fetch ticket to get acceptor
        const ticketData = await program.account.fillTicket.fetch(ticketPda);

        // Program enforces destination owner must be the FiatGuy; stranger ATA should fail with Unauthorized
        try {
            await (program.methods as any)
                .adminResolveUniversalTicket(true)
                .accounts({
                    admin: adminSigner.publicKey,
                    adminRentReceiver: adminSigner.publicKey,
                    order: orderPda,
                    vault: vaultPda,
                    ticket: ticketPda,
                    acceptor: ticketData.acceptor,
                    fiatGuyTokenAccount: strangerAta.address, // invalid destination (wrong owner)
                    cryptoGuyTokenAccount: cryptoGuy.ata,
                    adminFeeAccount: adminTokenAccount,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([adminSigner])
                .rpc();
            expect.fail("Admin resolve to stranger ATA should fail with Unauthorized");
        } catch (e: any) {
            const msg = e?.message || "";
            const logs = e?.logs?.join("\n") || "";
            expect(msg.includes("Unauthorized") || logs.includes("Unauthorized")).to.eq(true);
        }
    });

    it("Rejects unauthorized admin signer", async () => {
        const total = usdc(12);
        const fill  = usdc(4);
        const orderId = toBN(Date.now() + 9006);
        const { orderPda, vaultPda } = deriveOrderAndVault(cryptoGuy.kp.publicKey, orderId);

        const sellerBal = await getTokenBalance(connection, cryptoGuy.ata);
        if (sellerBal < total.toNumber()) {
            await mintMoreTokens(connection, provider.wallet.payer as Keypair, cryptoGuy.ata, tokenSetup, total.toNumber());
        }

        await (program.methods as any)
            .createUniversalOrder(orderId, total, toBN(1_000), true)
            .accounts({
                creator: cryptoGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: cryptoGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([cryptoGuy.kp, adminSigner])
            .rpc();

        await waitForCooldown();

        const ticketId = 1;
        const ticketPda = ticketPdaFor(orderPda, ticketId);
        await (program.methods as any)
            .acceptUniversalTicket(new anchor.BN(ticketId), fill)
            .accounts({
                acceptor: fiatGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([fiatGuy.kp, adminSigner])
            .rpc();

        // Fetch ticket to get acceptor
        const ticketData = await program.account.fillTicket.fetch(ticketPda);

        const fakeAdmin = Keypair.generate();
        // Fund fake admin minimally to cover tx if needed
        const transferTx = new Transaction().add(SystemProgram.transfer({ fromPubkey: provider.wallet.publicKey, toPubkey: fakeAdmin.publicKey, lamports: 100_000_000 }));
        await provider.sendAndConfirm(transferTx, [provider.wallet.payer as Keypair]);
        // Expect Unauthorized because signer must match hardcoded ADMIN_PUBKEY
        try {
            await (program.methods as any)
                .adminResolveUniversalTicket(true)
                .accounts({
                    admin: fakeAdmin.publicKey,
                    adminRentReceiver: adminSigner.publicKey,
                    order: orderPda,
                    vault: vaultPda,
                    ticket: ticketPda,
                    acceptor: ticketData.acceptor,
                    fiatGuyTokenAccount: fiatGuy.ata,
                    cryptoGuyTokenAccount: cryptoGuy.ata,
                    adminFeeAccount: adminTokenAccount,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([fakeAdmin])
                .rpc();
            expect.fail("Unauthorized admin signer should be rejected");
        } catch (e: any) {
            const msg = e?.message || "";
            const logs = e?.logs?.join("\n") || "";
            expect(msg.includes("Unauthorized") || logs.includes("Unauthorized")).to.eq(true);
        }
    });
});

describe("🛑 Universal Orders: cancel rules — Buy owner (FiatGuy)", () => {
    const { connection, provider, program } = setupAnchorEnvironment();
    const toBN = (n: number) => new anchor.BN(n);
    const usdc = (n: number) => new anchor.BN(Math.round(n * 1_000_000));

    type Party = { kp: Keypair; ata: PublicKey };

    let tokenSetup: TestTokenSetup;
    let fiatGuy: Party;
    let cryptoGuy: Party;
    let orderPda: PublicKey;
    let vaultPda: PublicKey;
    // Admin signer used as fee payer and rent receiver
    const adminSigner = TEST_WALLETS.buyer;

    before("setup mint + users", async () => {
        await checkDonorBalance(connection);
        const buyer = Keypair.generate();
        const seller = Keypair.generate();
        const env = await setupTestEnvironment(
            connection,
            provider.wallet.payer as Keypair,
            [buyer, seller],
            TEST_TOKEN_AMOUNT_100,
            6
        );
        tokenSetup = env.tokenSetup;
        fiatGuy   = { kp: buyer,  ata: env.userAccounts[0].tokenAccount };
        cryptoGuy = { kp: seller, ata: env.userAccounts[1].tokenAccount };
    });

    const deriveOrder = (orderId: anchor.BN) => {
        const orderSeed = Buffer.from("universal_order");
        const vaultSeed = Buffer.from("vault");
        const orderIdBuf = orderId.toArrayLike(Buffer, "le", 8);
        const [o] = PublicKey.findProgramAddressSync(
            [orderSeed, fiatGuy.kp.publicKey.toBuffer(), tokenSetup.mint.toBuffer(), orderIdBuf],
            program.programId,
        );
        const [v] = PublicKey.findProgramAddressSync(
            [vaultSeed, o.toBuffer()],
            program.programId,
        );
        return { o, v };
    };

    const ticketPdaFor = (order: PublicKey, id: number) =>
        PublicKey.findProgramAddressSync([
            Buffer.from("ticket"), order.toBuffer(), toBN(id).toArrayLike(Buffer, "le", 8)
        ], program.programId)[0];

    it("3) FiatGuy (owner) can cancel a not-paid ticket; reserved returns to pool (refund to seller)", async () => {
        const orderId = toBN(Date.now() + 3001);
        ({ o: orderPda, v: vaultPda } = deriveOrder(orderId));

        // Create Buy order 100
        await (program.methods as any)
            .createUniversalOrder(orderId, usdc(100), toBN(2_000), false)
            .accounts({
                creator: fiatGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([fiatGuy.kp, adminSigner])
            .rpc();

        await waitForCooldown();

        // CryptoGuy accepts 30 (deposits to vault)
        const ticketId = 1;
        const ticketPda = ticketPdaFor(orderPda, ticketId);
        await (program.methods as any)
            .acceptUniversalTicket(toBN(ticketId), usdc(30))
            .accounts({
                acceptor: cryptoGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptorTokenAccount: cryptoGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([cryptoGuy.kp, adminSigner])
            .rpc();

        // FiatGuy cancels the ticket (he hasn't signed; refund to seller)
        const beforeSeller = await getTokenBalance(connection, cryptoGuy.ata);
        const ticketDataCancel4 = await program.account.fillTicket.fetch(ticketPda);
        await (program.methods as any)
            .cancelUniversalTicket()
            .accounts({
                canceller: fiatGuy.kp.publicKey,
                adminRentReceiver: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptor: ticketDataCancel4.acceptor,
                acceptorTokenAccount: cryptoGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([fiatGuy.kp])
            .rpc();
        const afterSeller = await getTokenBalance(connection, cryptoGuy.ata);
        expect(afterSeller - beforeSeller).to.eq(usdc(30).toNumber());

        // With no active reservations, FiatGuy can cancel order
        await waitForCooldown();
        await (program.methods as any)
            .cancelUniversalOrder()
            .accounts({
                creator: fiatGuy.kp.publicKey,
                order: orderPda,
                vault: vaultPda,
                // Optional account provided to satisfy Anchor
                creatorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([fiatGuy.kp])
            .rpc();
    });

    it("5) FiatGuy can cancel a Buy order when no active sellers exist (no tickets)", async () => {
        const orderId = toBN(Date.now() + 3002);
        ({ o: orderPda, v: vaultPda } = deriveOrder(orderId));

        await (program.methods as any)
            .createUniversalOrder(orderId, usdc(50), toBN(1_000), false)
            .accounts({
                creator: fiatGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([fiatGuy.kp, adminSigner])
            .rpc();

        // No tickets -> can cancel immediately
        await waitForCooldown();
        await (program.methods as any)
            .cancelUniversalOrder()
            .accounts({
                creator: fiatGuy.kp.publicKey,
                order: orderPda,
                vault: vaultPda,
                creatorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([fiatGuy.kp])
            .rpc();
    });
});

// 🔁 Re-fill after cancellation flows (full + partial, buy + sell)
describe("🔁 Universal Orders: re-fill after cancellation", () => {
    const { connection, provider, program } = setupAnchorEnvironment();
    const toBN = (n: number) => new anchor.BN(n);
    const usdc = (n: number) => new anchor.BN(Math.round(n * 1_000_000));

    type Actor = { kp: Keypair; ata: PublicKey };
    let tokenSetup: TestTokenSetup;
    let fiatGuy: Actor;      // Buyer (creates Buy orders)
    let cryptoGuy: Actor;    // Seller (creates Sell orders)
    let extraSellers: Actor[] = [];
    let extraBuyers: Actor[] = [];
    let adminTokenAccount: PublicKey;
    const adminSigner = TEST_WALLETS.buyer;

    before("airdrop + mint tokens for all participants", async () => {
        await checkDonorBalance(connection);

        // Create keypairs: creator sides + pools of counterparties
        const buyer = Keypair.generate();
        const seller = Keypair.generate();
        const sellerPool = Array.from({ length: 4 }, () => Keypair.generate());
        const buyerPool  = Array.from({ length: 4 }, () => Keypair.generate());
        const env = await setupTestEnvironment(
            connection,
            provider.wallet.payer as Keypair,
            [buyer, seller, ...sellerPool, ...buyerPool],
            TEST_TOKEN_AMOUNT_100 * 5,
            6
        );
        tokenSetup = env.tokenSetup;
        // order: index mapping as passed above
        fiatGuy   = { kp: buyer,  ata: env.userAccounts[0].tokenAccount };
        cryptoGuy = { kp: seller, ata: env.userAccounts[1].tokenAccount };
        extraSellers = sellerPool.map((kp, i) => ({ kp, ata: env.userAccounts[2 + i].tokenAccount }));
        extraBuyers  = buyerPool.map((kp, i)  => ({ kp, ata: env.userAccounts[2 + sellerPool.length + i].tokenAccount }));

        // Admin fee ATA (owned by hardcoded admin); provider pays rent if missing
        const adminAtaInfo = await getOrCreateAssociatedTokenAccount(
            connection,
            provider.wallet.payer as Keypair,
            tokenSetup.mint,
            adminSigner.publicKey
        );
        adminTokenAccount = adminAtaInfo.address;
    });

    const deriveOrderAndVault = (creator: PublicKey, orderId: anchor.BN) => {
        const orderSeed = Buffer.from("universal_order");
        const vaultSeed = Buffer.from("vault");
        const orderIdBuf = orderId.toArrayLike(Buffer, "le", 8);
        const [orderPda] = PublicKey.findProgramAddressSync(
            [orderSeed, creator.toBuffer(), tokenSetup.mint.toBuffer(), orderIdBuf],
            program.programId,
        );
        const [vaultPda] = PublicKey.findProgramAddressSync([
            vaultSeed, orderPda.toBuffer()
        ], program.programId);
        return { orderPda, vaultPda };
    };

    const ticketPdaFor = (order: PublicKey, id: number) =>
        PublicKey.findProgramAddressSync([
            Buffer.from("ticket"), order.toBuffer(), toBN(id).toArrayLike(Buffer, "le", 8)
        ], program.programId)[0];

    // Helper to fetch order
    const fetchOrder = async (pda: PublicKey) => (program.account as any).universalOrder.fetch(pda);
    const getBal = (ata: PublicKey) => getTokenBalance(connection, ata);

    // BUY ORDER — full accept -> cancel by first seller -> second seller refills fully & settlement
    it("Buy order: full accept canceled then refilled fully by another seller", async () => {
        const total = usdc(40); // 40 tokens target
        const orderId = toBN(Date.now() + 8001);
        const { orderPda, vaultPda } = deriveOrderAndVault(fiatGuy.kp.publicKey, orderId);

        // Create Buy order (Fiat locks nothing)
        await (program.methods as any)
            .createUniversalOrder(orderId, total, toBN(5_000), false)
            .accounts({
                creator: fiatGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([fiatGuy.kp, adminSigner])
            .rpc();

        await waitForCooldown();

        // First seller accepts full
        const seller1 = extraSellers[0];
        const ticket1Id = 1;
        const ticket1Pda = ticketPdaFor(orderPda, ticket1Id);
        await (program.methods as any)
            .acceptUniversalTicket(toBN(ticket1Id), total)
            .accounts({
                acceptor: seller1.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticket1Pda,
                acceptorTokenAccount: seller1.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller1.kp, adminSigner])
            .rpc();

        // Seller1 changes mind -> cancel ticket before any signature
        const ticketDataCancel5 = await program.account.fillTicket.fetch(ticket1Pda);
        await (program.methods as any)
            .cancelUniversalTicket()
            .accounts({
                canceller: seller1.kp.publicKey,
                adminRentReceiver: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticket1Pda,
                acceptor: ticketDataCancel5.acceptor,
                acceptorTokenAccount: seller1.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([seller1.kp])
            .rpc();

        // Refill by second seller (new ticket id = 2)
        await waitForCooldown();
        const seller2 = extraSellers[1];
        const ticket2Id = 2;
        const ticket2Pda = ticketPdaFor(orderPda, ticket2Id);
        await (program.methods as any)
            .acceptUniversalTicket(toBN(ticket2Id), total)
            .accounts({
                acceptor: seller2.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticket2Pda,
                acceptorTokenAccount: seller2.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([seller2.kp, adminSigner])
            .rpc();

        await waitForCooldown();
        // Settlement: Fiat signs first (rule), then seller2
        const fiatBefore = await getBal(fiatGuy.ata);
        const ticketData3 = await program.account.fillTicket.fetch(ticket2Pda);
        await (program.methods as any)
            .signUniversalTicket()
            .accounts({
                signer: fiatGuy.kp.publicKey,
                adminRentReceiver: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticket2Pda,
                acceptor: ticketData3.acceptor,
                fiatGuyTokenAccount: fiatGuy.ata,
                adminFeeAccount: adminTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([fiatGuy.kp])
            .rpc();
        await (program.methods as any)
            .signUniversalTicket()
            .accounts({
                signer: seller2.kp.publicKey,
                adminRentReceiver: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticket2Pda,
                acceptor: ticketData3.acceptor,
                fiatGuyTokenAccount: fiatGuy.ata,
                adminFeeAccount: adminTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([seller2.kp])
            .rpc();

    const fiatAfter = await getBal(fiatGuy.ata);
    // 0.2% fee per ticket
    const fee1 = Math.floor(total.toNumber() * 20 / 10_000);
    expect(fiatAfter - fiatBefore).to.eq(total.toNumber() - fee1);
        const orderAcc = await fetchOrder(orderPda);
        expect(Number(orderAcc.filledAmount)).to.eq(total.toNumber());
        expect(Number(orderAcc.reservedAmount)).to.eq(0);
    });

    // BUY ORDER — partial fills with one cancellation then remaining fills & settlement
    it("Buy order: partial fills with one seller cancellation then others settle remainder", async () => {
        const total = usdc(50);
        const orderId = toBN(Date.now() + 8002);
        const { orderPda, vaultPda } = deriveOrderAndVault(fiatGuy.kp.publicKey, orderId);
        await (program.methods as any)
            .createUniversalOrder(orderId, total, toBN(9_000), false)
            .accounts({
                creator: fiatGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([fiatGuy.kp, adminSigner])
            .rpc();
        await waitForCooldown();

        // Seller A accepts 20 then cancels
        const sellerA = extraSellers[2];
        const t1 = 1; const t1Pda = ticketPdaFor(orderPda, t1);
        await (program.methods as any)
            .acceptUniversalTicket(toBN(t1), usdc(20))
            .accounts({ acceptor: sellerA.kp.publicKey, feePayer: adminSigner.publicKey, order: orderPda, vault: vaultPda, ticket: t1Pda, acceptorTokenAccount: sellerA.ata, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
            .signers([sellerA.kp, adminSigner]).rpc();
        const ticketDataCancel6 = await program.account.fillTicket.fetch(t1Pda);
        await (program.methods as any)
            .cancelUniversalTicket()
            .accounts({ canceller: sellerA.kp.publicKey, adminRentReceiver: adminSigner.publicKey, order: orderPda, vault: vaultPda, ticket: t1Pda, acceptor: ticketDataCancel6.acceptor, acceptorTokenAccount: sellerA.ata, tokenProgram: TOKEN_PROGRAM_ID })
            .signers([sellerA.kp]).rpc();

        await waitForCooldown();
        // Seller B accepts 30; Seller C accepts 20 (will exceed? adjust to final 50). We'll do 30 then 20 -> total 50
        const sellerB = extraSellers[0];
        const sellerC = extraSellers[1];
        const t2 = 2; const t2Pda = ticketPdaFor(orderPda, t2);
        await (program.methods as any)
            .acceptUniversalTicket(toBN(t2), usdc(30))
            .accounts({ acceptor: sellerB.kp.publicKey, feePayer: adminSigner.publicKey, order: orderPda, vault: vaultPda, ticket: t2Pda, acceptorTokenAccount: sellerB.ata, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
            .signers([sellerB.kp, adminSigner]).rpc();
        await waitForCooldown();
        const t3 = 3; const t3Pda = ticketPdaFor(orderPda, t3);
        await (program.methods as any)
            .acceptUniversalTicket(toBN(t3), usdc(20))
            .accounts({ acceptor: sellerC.kp.publicKey, feePayer: adminSigner.publicKey, order: orderPda, vault: vaultPda, ticket: t3Pda, acceptorTokenAccount: sellerC.ata, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
            .signers([sellerC.kp, adminSigner]).rpc();

        // Sign & settle ticket 2 then ticket 3
        await waitForCooldown();
        const fiatBefore = await getBal(fiatGuy.ata);
        for (const { id, pda, seller } of [ { id: t2, pda: t2Pda, seller: sellerB }, { id: t3, pda: t3Pda, seller: sellerC } ]) {
            // Fiat signs first
            const ticketDataLoop = await program.account.fillTicket.fetch(pda);
            await (program.methods as any)
                .signUniversalTicket()
                .accounts({ signer: fiatGuy.kp.publicKey, adminRentReceiver: adminSigner.publicKey, order: orderPda, vault: vaultPda, ticket: pda, acceptor: ticketDataLoop.acceptor, fiatGuyTokenAccount: fiatGuy.ata, adminFeeAccount: adminTokenAccount, tokenProgram: TOKEN_PROGRAM_ID })
                .signers([fiatGuy.kp]).rpc();
            await (program.methods as any)
                .signUniversalTicket()
                .accounts({ signer: seller.kp.publicKey, adminRentReceiver: adminSigner.publicKey, order: orderPda, vault: vaultPda, ticket: pda, acceptor: ticketDataLoop.acceptor, fiatGuyTokenAccount: fiatGuy.ata, adminFeeAccount: adminTokenAccount, tokenProgram: TOKEN_PROGRAM_ID })
                .signers([seller.kp]).rpc();
            await waitForCooldown();
        }
    const fiatAfter = await getBal(fiatGuy.ata);
    // 0.2% fee on each settled ticket: 30 and 20
    const perFees = [usdc(30).toNumber(), usdc(20).toNumber()].map(x => Math.floor(x * 20 / 10_000));
    const totalFee = perFees.reduce((a, b) => a + b, 0);
    expect(fiatAfter - fiatBefore).to.eq(usdc(50).toNumber() - totalFee);
        const orderAcc = await fetchOrder(orderPda);
        expect(Number(orderAcc.filledAmount)).to.eq(usdc(50).toNumber());
        expect(Number(orderAcc.reservedAmount)).to.eq(0);
    });

    // SELL ORDER — full accept -> cancel by buyer -> new buyer refills & settlement
    it("Sell order: full accept canceled then refilled fully by another buyer", async () => {
        const total = usdc(30);
        const orderId = toBN(Date.now() + 8003);
        const { orderPda, vaultPda } = deriveOrderAndVault(cryptoGuy.kp.publicKey, orderId);
        // Ensure seller has balance
        const sellerBal = await getBal(cryptoGuy.ata);
        if (sellerBal < total.toNumber()) {
            await mintMoreTokens(connection, provider.wallet.payer as Keypair, cryptoGuy.ata, tokenSetup, total.toNumber());
        }
        await (program.methods as any)
            .createUniversalOrder(orderId, total, toBN(4_000), true)
            .accounts({
                creator: cryptoGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: cryptoGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([cryptoGuy.kp, adminSigner]).rpc();
        await waitForCooldown();

        const buyer1 = extraBuyers[0];
        const t1 = 1; const t1Pda = ticketPdaFor(orderPda, t1);
        await (program.methods as any)
            .acceptUniversalTicket(toBN(t1), total)
            .accounts({ acceptor: buyer1.kp.publicKey, feePayer: adminSigner.publicKey, order: orderPda, vault: vaultPda, ticket: t1Pda, acceptorTokenAccount: buyer1.ata, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
            .signers([buyer1.kp, adminSigner]).rpc();

        // Buyer1 cancels (FiatGuy hasn't signed yet)
        const ticketDataCancel7 = await program.account.fillTicket.fetch(t1Pda);
        await (program.methods as any)
            .cancelUniversalTicket()
            .accounts({ canceller: buyer1.kp.publicKey, adminRentReceiver: adminSigner.publicKey, order: orderPda, vault: vaultPda, ticket: t1Pda, acceptor: ticketDataCancel7.acceptor, acceptorTokenAccount: buyer1.ata, tokenProgram: TOKEN_PROGRAM_ID })
            .signers([buyer1.kp]).rpc();

        await waitForCooldown();

        // Buyer2 refills
        const buyer2 = extraBuyers[1];
        const t2 = 2; const t2Pda = ticketPdaFor(orderPda, t2);
        await (program.methods as any)
            .acceptUniversalTicket(toBN(t2), total)
            .accounts({ acceptor: buyer2.kp.publicKey, feePayer: adminSigner.publicKey, order: orderPda, vault: vaultPda, ticket: t2Pda, acceptorTokenAccount: buyer2.ata, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
            .signers([buyer2.kp, adminSigner]).rpc();

        await waitForCooldown();
        const buyerBefore = await getBal(buyer2.ata);
        // Settlement order: Fiat (buyer2) signs first, then Crypto (seller) signs
        const ticketData4 = await program.account.fillTicket.fetch(t2Pda);
        await (program.methods as any)
            .signUniversalTicket()
            .accounts({ signer: buyer2.kp.publicKey, adminRentReceiver: adminSigner.publicKey, order: orderPda, vault: vaultPda, ticket: t2Pda, acceptor: ticketData4.acceptor, fiatGuyTokenAccount: buyer2.ata, adminFeeAccount: adminTokenAccount, tokenProgram: TOKEN_PROGRAM_ID })
            .signers([buyer2.kp]).rpc();
        await (program.methods as any)
            .signUniversalTicket()
            .accounts({ signer: cryptoGuy.kp.publicKey, adminRentReceiver: adminSigner.publicKey, order: orderPda, vault: vaultPda, ticket: t2Pda, acceptor: ticketData4.acceptor, fiatGuyTokenAccount: buyer2.ata, adminFeeAccount: adminTokenAccount, tokenProgram: TOKEN_PROGRAM_ID })
            .signers([cryptoGuy.kp]).rpc();
    const buyerAfter = await getBal(buyer2.ata);
    // 0.2% fee on the settled ticket
    const fee2 = Math.floor(total.toNumber() * 20 / 10_000);
    expect(buyerAfter - buyerBefore).to.eq(total.toNumber() - fee2);
        const orderAcc = await fetchOrder(orderPda);
        expect(Number(orderAcc.filledAmount)).to.eq(total.toNumber());
        expect(Number(orderAcc.reservedAmount)).to.eq(0);
    });

    // SELL ORDER — partial buyers with one cancellation then final settlement
    it("Sell order: partial accepts with buyer cancellation then others settle remainder", async () => {
        const total = usdc(60);
        const orderId = toBN(Date.now() + 8004);
        const { orderPda, vaultPda } = deriveOrderAndVault(cryptoGuy.kp.publicKey, orderId);
        // Ensure seller balance
        const sellerBal = await getBal(cryptoGuy.ata);
        if (sellerBal < total.toNumber()) {
            await mintMoreTokens(connection, provider.wallet.payer as Keypair, cryptoGuy.ata, tokenSetup, total.toNumber());
        }
        await (program.methods as any)
            .createUniversalOrder(orderId, total, toBN(10_000), true)
            .accounts({ creator: cryptoGuy.kp.publicKey, feePayer: adminSigner.publicKey, order: orderPda, mint: tokenSetup.mint, vault: vaultPda, creatorTokenAccount: cryptoGuy.ata, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
            .signers([cryptoGuy.kp, adminSigner]).rpc();
        await waitForCooldown();

        const buyerA = extraBuyers[2];
        const buyerB = extraBuyers[0];
        const buyerC = extraBuyers[1];

        // BuyerA accepts 25 then cancels
        const t1 = 1; const t1Pda = ticketPdaFor(orderPda, t1);
        await (program.methods as any)
            .acceptUniversalTicket(toBN(t1), usdc(25))
            .accounts({ acceptor: buyerA.kp.publicKey, feePayer: adminSigner.publicKey, order: orderPda, vault: vaultPda, ticket: t1Pda, acceptorTokenAccount: buyerA.ata, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
            .signers([buyerA.kp, adminSigner]).rpc();
        const ticketDataCancel8 = await program.account.fillTicket.fetch(t1Pda);
        await (program.methods as any)
            .cancelUniversalTicket()
            .accounts({ canceller: buyerA.kp.publicKey, adminRentReceiver: adminSigner.publicKey, order: orderPda, vault: vaultPda, ticket: t1Pda, acceptor: ticketDataCancel8.acceptor, acceptorTokenAccount: buyerA.ata, tokenProgram: TOKEN_PROGRAM_ID })
            .signers([buyerA.kp]).rpc();
        await waitForCooldown();

        // BuyerB accepts 30, BuyerC accepts 30 (total 60)
        const t2 = 2; const t2Pda = ticketPdaFor(orderPda, t2);
        await (program.methods as any)
            .acceptUniversalTicket(toBN(t2), usdc(30))
            .accounts({ acceptor: buyerB.kp.publicKey, feePayer: adminSigner.publicKey, order: orderPda, vault: vaultPda, ticket: t2Pda, acceptorTokenAccount: buyerB.ata, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
            .signers([buyerB.kp, adminSigner]).rpc();
        await waitForCooldown();
        const t3 = 3; const t3Pda = ticketPdaFor(orderPda, t3);
        await (program.methods as any)
            .acceptUniversalTicket(toBN(t3), usdc(30))
            .accounts({ acceptor: buyerC.kp.publicKey, feePayer: adminSigner.publicKey, order: orderPda, vault: vaultPda, ticket: t3Pda, acceptorTokenAccount: buyerC.ata, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
            .signers([buyerC.kp, adminSigner]).rpc();

        // Settle each ticket sequentially (Fiat/buyer signs first then Crypto)
        const settle = async (pda: PublicKey, buyer: Actor) => {
            const ticketDataSettle = await program.account.fillTicket.fetch(pda);
            await (program.methods as any)
                .signUniversalTicket()
                .accounts({ signer: buyer.kp.publicKey, adminRentReceiver: adminSigner.publicKey, order: orderPda, vault: vaultPda, ticket: pda, acceptor: ticketDataSettle.acceptor, fiatGuyTokenAccount: buyer.ata, adminFeeAccount: adminTokenAccount, tokenProgram: TOKEN_PROGRAM_ID })
                .signers([buyer.kp]).rpc();
            await (program.methods as any)
                .signUniversalTicket()
                .accounts({ signer: cryptoGuy.kp.publicKey, adminRentReceiver: adminSigner.publicKey, order: orderPda, vault: vaultPda, ticket: pda, acceptor: ticketDataSettle.acceptor, fiatGuyTokenAccount: buyer.ata, adminFeeAccount: adminTokenAccount, tokenProgram: TOKEN_PROGRAM_ID })
                .signers([cryptoGuy.kp]).rpc();
            await waitForCooldown();
        };
        await settle(t2Pda, buyerB);
        await settle(t3Pda, buyerC);

        const orderAcc = await fetchOrder(orderPda);
        expect(Number(orderAcc.filledAmount)).to.eq(total.toNumber());
        expect(Number(orderAcc.reservedAmount)).to.eq(0);
    });

    after("collect remaining tokens back to provider", async function () {
        this.timeout(90000);
        try {
            const payer = provider.wallet.payer as Keypair;
            const mainAtaInfo = await getOrCreateAssociatedTokenAccount(
                connection, payer, tokenSetup.mint, payer.publicKey
            );
            const mainAta = mainAtaInfo.address;
            const allActors: Actor[] = [fiatGuy, cryptoGuy, ...extraSellers, ...extraBuyers];
            for (const actor of allActors) {
                try {
                    const bal = await getBal(actor.ata);
                    if (bal > 0) {
                        await transfer(connection, payer, actor.ata, mainAta, actor.kp, bal);
                    }
                } catch (e) { /* best-effort cleanup */ }
            }
        } catch (e) { /* swallow cleanup errors */ }
    });
});


describe("🧪 Universal Orders: partial fills and close (DRY)", () => {
    const { connection, provider, program } = setupAnchorEnvironment();

    // Helpers (DRY)
    const toBN = (n: number) => new anchor.BN(n);
    const usdc = (n: number) => new anchor.BN(Math.round(n * 1_000_000));

    type Buyer = { kp: Keypair; ata: PublicKey };

    let tokenSetup: TestTokenSetup;
    let cryptoGuy: Keypair;
    let cryptoGuyAta: PublicKey;
    let buyers: Buyer[] = [];
    let adminTokenAccount: PublicKey;

    // Admin signer from ENV config (used as fee payer and rent receiver)
    const adminSigner = TEST_WALLETS.buyer;

    let orderId: anchor.BN;
    let orderPda: PublicKey;
    let vaultPda: PublicKey;

    // Arrange
    before("setup mint, seller and 5 buyers", async () => {
        await checkDonorBalance(connection);
        cryptoGuy = Keypair.generate();
        const buyerKps = Array.from({ length: 5 }, () => Keypair.generate());

        const env = await setupTestEnvironment(
            connection,
            provider.wallet.payer as Keypair,
            [cryptoGuy, ...buyerKps],
            TEST_TOKEN_AMOUNT_100,
            6
        );
        tokenSetup = env.tokenSetup;
        cryptoGuyAta = env.userAccounts[0].tokenAccount;
        buyers = buyerKps.map((kp, i) => ({ kp, ata: env.userAccounts[i + 1].tokenAccount }));

        // Derive PDAs for order and vault
        orderId = toBN(Date.now() + 123);
        const orderSeed = Buffer.from("universal_order");
        const vaultSeed = Buffer.from("vault");
        const orderIdBuf = orderId.toArrayLike(Buffer, "le", 8);
        [orderPda] = PublicKey.findProgramAddressSync(
            [orderSeed, cryptoGuy.publicKey.toBuffer(), tokenSetup.mint.toBuffer(), orderIdBuf],
            program.programId,
        );
        [vaultPda] = PublicKey.findProgramAddressSync(
            [vaultSeed, orderPda.toBuffer()],
            program.programId,
        );

        // Admin fee ATA (owned by hardcoded admin); provider pays rent if missing
        const adminAtaInfo = await getOrCreateAssociatedTokenAccount(
            connection,
            provider.wallet.payer as Keypair,
            tokenSetup.mint,
            adminSigner.publicKey
        );
        adminTokenAccount = adminAtaInfo.address;
    });

    // Tiny helpers
    const waitCooldown = async () => { await waitForCooldown(); };
    const getOrder = async () => (program.account as any).universalOrder.fetch(orderPda);
    const getVaultBal = async () => getTokenBalance(connection, vaultPda);

    const acceptTicket = async (buyer: Buyer, ticketId: number, amount: anchor.BN) => {
        const [ticketPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("ticket"), orderPda.toBuffer(), toBN(ticketId).toArrayLike(Buffer, "le", 8)],
            program.programId
        );
        try {
            await (program.methods as any)
                .acceptUniversalTicket(toBN(ticketId), amount)
                .accounts({
                    acceptor: buyer.kp.publicKey,
                    feePayer: adminSigner.publicKey,
                    order: orderPda,
                    vault: vaultPda,
                    ticket: ticketPda,
                    // Not required for Sell orders, but harmless to include
                    acceptorTokenAccount: buyer.ata,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([buyer.kp, adminSigner])
                .rpc();
        } catch (e: any) {
            if (e instanceof SendTransactionError && e.getLogs) {
                const logs = await e.getLogs(connection).catch(() => undefined);
                console.error("acceptUniversalTicket logs:\n" + (logs?.join("\n") || e.logs?.join("\n") || "<no logs>"));
            } else if (e?.logs) {
                console.error("acceptUniversalTicket logs:\n" + e.logs.join("\n"));
            }
            throw e;
        }
        return ticketPda;
    };

    const signTicketBy = async (signer: Keypair, ticketPda: PublicKey, fiatGuyAta: PublicKey) => {
        try {
            const ticketDataSign = await program.account.fillTicket.fetch(ticketPda);
            await (program.methods as any)
                .signUniversalTicket()
                .accounts({
                    signer: signer.publicKey,
                    adminRentReceiver: adminSigner.publicKey,
                    order: orderPda,
                    vault: vaultPda,
                    ticket: ticketPda,
                    acceptor: ticketDataSign.acceptor,
                    fiatGuyTokenAccount: fiatGuyAta,
                    adminFeeAccount: adminTokenAccount,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([signer])
                .rpc();
        } catch (e: any) {
            if (e instanceof SendTransactionError && e.getLogs) {
                const logs = await e.getLogs(connection).catch(() => undefined);
                console.error("signUniversalTicket logs:\n" + (logs?.join("\n") || e.logs?.join("\n") || "<no logs>"));
            } else if (e?.logs) {
                console.error("signUniversalTicket logs:\n" + e.logs.join("\n"));
            }
            throw e;
        }
    };

    it("arrange: create Sell order 10 USDC and lock to vault", async () => {
        const before = await getTokenBalance(connection, cryptoGuyAta);

        await (program.methods as any)
            .createUniversalOrder(orderId, usdc(10), toBN(1_000), true)
            .accounts({
                creator: cryptoGuy.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: cryptoGuyAta,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([cryptoGuy, adminSigner])
            .rpc();

        const order = await getOrder();
        const vaultBal = await getVaultBal();
        const after = await getTokenBalance(connection, cryptoGuyAta);
        expect(order.isSellOrder).to.eq(true);
        expect(Number(order.cryptoAmount)).to.eq(usdc(10).toNumber());
        expect(vaultBal).to.eq(usdc(10).toNumber());
        expect(before - after).to.eq(usdc(10).toNumber());
        
        // Wait for cooldown before next actions
        await waitCooldown();
    });

    it("act: buyers accept and settle tickets leaving only dust", async () => {
        // Buyer 1 accepts 3 USDC
        const ticket1 = await acceptTicket(buyers[0], 1, usdc(3));
        await waitCooldown();
        
        // Buyer 2 accepts 3 USDC
        const ticket2 = await acceptTicket(buyers[1], 2, usdc(3));
        await waitCooldown();
        
        // Buyer 3 accepts 3.5 USDC (total 9.5 USDC, leaving 0.5 USDC as dust)
        const ticket3 = await acceptTicket(buyers[2], 3, usdc(3.5));
        await waitCooldown();

        // Settle all 3 tickets
        for (const { ticket, buyer } of [
            { ticket: ticket1, buyer: buyers[0] },
            { ticket: ticket2, buyer: buyers[1] },
            { ticket: ticket3, buyer: buyers[2] }
        ]) {
            await signTicketBy(buyer.kp, ticket, buyer.ata);
            await signTicketBy(cryptoGuy, ticket, buyer.ata);
            await waitCooldown();
        }

        // Verify: 9.5 filled, 0.5 remaining (dust)
        const order = await getOrder();
        expect(Number(order.filledAmount)).to.eq(usdc(9.5).toNumber());
        expect(Number(order.reservedAmount)).to.eq(0);
        const remaining = Number(order.cryptoAmount) - Number(order.filledAmount);
        expect(remaining).to.eq(usdc(0.5).toNumber());
        expect(remaining).to.be.lessThan(1_000_000); // < 1 USDC dust
    });

    it("assert: close with dust returns remainder to seller and closes the order", async () => {
        const beforeCreator = await getTokenBalance(connection, cryptoGuyAta);
        const beforeVault = await getVaultBal();

        // Respect cooldown after last settlement before closing
        await waitCooldown();

        await (program.methods as any)
            .closeUniversalOrder()
            .accounts({
                closer: cryptoGuy.publicKey,
                adminRentReceiver: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                creatorTokenAccount: cryptoGuyAta,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([cryptoGuy])
            .rpc();

        // Creator should receive the dust back
        const afterCreator = await getTokenBalance(connection, cryptoGuyAta);
        const afterVault = await getVaultBal().catch(() => 0); // vault still exists but will be near zero
        expect(afterCreator - beforeCreator).to.eq(beforeVault); // entire vault remainder returned
        expect(afterVault).to.eq(0); // vault drained

        // Fetching the order should now fail (account closed)
        let closed = false;
        try { await getOrder(); } catch { closed = true; }
        expect(closed).to.eq(true);
    });

    // Cleanup tokens back to main wallet
    after("return tokens back to main wallet", async function () {
        this.timeout(30000);
        try {
            if (!tokenSetup) return;
            const payer = provider.wallet.payer as Keypair;
            const mainAtaInfo = await getOrCreateAssociatedTokenAccount(
                connection, payer, tokenSetup.mint, payer.publicKey
            );
            const mainAta = mainAtaInfo.address;
            const all = [ { label: "Seller", owner: cryptoGuy, ata: cryptoGuyAta }, ...buyers.map((b, i) => ({ label: `Buyer${i+1}`, owner: b.kp, ata: b.ata })) ];
            for (const u of all) {
                try {
                    const bal = await getTokenBalance(connection, u.ata);
                    if (bal > 0) {
                        await transfer(connection, payer, u.ata, mainAta, u.owner, bal);
                    }
                } catch {}
            }
        } catch {}
    });
});


describe("🧪 Universal Orders: BUY partial fills and close (DRY)", () => {
    const { connection, provider, program } = setupAnchorEnvironment();

    // Helpers (DRY)
    const toBN = (n: number) => new anchor.BN(n);
    const usdc = (n: number) => new anchor.BN(Math.round(n * 1_000_000));

    type Seller = { kp: Keypair; ata: PublicKey };

    let tokenSetup: TestTokenSetup;
    let fiatGuy: Keypair;
    let fiatGuyAta: PublicKey;
    let sellers: Seller[] = [];
    let adminTokenAccount: PublicKey;

    // Admin signer for fee payer and rent receiver from ENV config
    const adminSigner = TEST_WALLETS.buyer;

    let orderId: anchor.BN;
    let orderPda: PublicKey;
    let vaultPda: PublicKey;

    // Arrange
    before("setup mint, buyer (FiatGuy) and 5 sellers", async () => {
        await checkDonorBalance(connection);
        fiatGuy = Keypair.generate();
        const sellerKps = Array.from({ length: 5 }, () => Keypair.generate());

        const env = await setupTestEnvironment(
            connection,
            provider.wallet.payer as Keypair,
            [fiatGuy, ...sellerKps],
            TEST_TOKEN_AMOUNT_100,
            6
        );
        tokenSetup = env.tokenSetup;
        fiatGuyAta = env.userAccounts[0].tokenAccount;
        sellers = sellerKps.map((kp, i) => ({ kp, ata: env.userAccounts[i + 1].tokenAccount }));

        // Derive PDAs for order and vault (creator = FiatGuy)
        orderId = toBN(Date.now() + 987);
        const orderSeed = Buffer.from("universal_order");
        const vaultSeed = Buffer.from("vault");
        const orderIdBuf = orderId.toArrayLike(Buffer, "le", 8);
        [orderPda] = PublicKey.findProgramAddressSync(
            [orderSeed, fiatGuy.publicKey.toBuffer(), tokenSetup.mint.toBuffer(), orderIdBuf],
            program.programId,
        );
        [vaultPda] = PublicKey.findProgramAddressSync(
            [vaultSeed, orderPda.toBuffer()],
            program.programId,
        );

        // Prepare admin fee ATA (owned by the hardcoded admin); provider pays rent if missing
        const adminAtaInfo = await getOrCreateAssociatedTokenAccount(
            connection,
            provider.wallet.payer as Keypair,
            tokenSetup.mint,
            adminSigner.publicKey
        );
        adminTokenAccount = adminAtaInfo.address;
    });

    // Tiny helpers
    const waitCooldown = async () => { await waitForCooldown(); };
    const getOrder = async () => (program.account as any).universalOrder.fetch(orderPda);
    const getVaultBal = async () => getTokenBalance(connection, vaultPda);

    const acceptTicket = async (seller: Seller, ticketId: number, amount: anchor.BN) => {
        const [ticketPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("ticket"), orderPda.toBuffer(), toBN(ticketId).toArrayLike(Buffer, "le", 8)],
            program.programId
        );
        try {
            await (program.methods as any)
                .acceptUniversalTicket(toBN(ticketId), amount)
                .accounts({
                    acceptor: seller.kp.publicKey,
                    feePayer: adminSigner.publicKey,
                    order: orderPda,
                    vault: vaultPda,
                    ticket: ticketPda,
                    acceptorTokenAccount: seller.ata, // For Buy orders: move tokens into vault on accept
                    tokenProgram: TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([seller.kp, adminSigner])
                .rpc();
        } catch (e: any) {
            if (e instanceof SendTransactionError && e.getLogs) {
                const logs = await e.getLogs(connection).catch(() => undefined);
                console.error("acceptUniversalTicket logs:\n" + (logs?.join("\n") || e.logs?.join("\n") || "<no logs>"));
            } else if (e?.logs) {
                console.error("acceptUniversalTicket logs:\n" + e.logs.join("\n"));
            }
            throw e;
        }
        return ticketPda;
    };

    const signTicketBy = async (signer: Keypair, ticketPda: PublicKey) => {
        try {
            const ticketDataSign2 = await program.account.fillTicket.fetch(ticketPda);
            await (program.methods as any)
                .signUniversalTicket()
                .accounts({
                    signer: signer.publicKey,
                    adminRentReceiver: adminSigner.publicKey,
                    order: orderPda,
                    vault: vaultPda,
                    ticket: ticketPda,
                    acceptor: ticketDataSign2.acceptor,
                    fiatGuyTokenAccount: fiatGuyAta, // Destination for settlement in Buy orders
                    adminFeeAccount: adminTokenAccount,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([signer])
                .rpc();
        } catch (e: any) {
            if (e instanceof SendTransactionError && e.getLogs) {
                const logs = await e.getLogs(connection).catch(() => undefined);
                console.error("signUniversalTicket logs:\n" + (logs?.join("\n") || e.logs?.join("\n") || "<no logs>"));
            } else if (e?.logs) {
                console.error("signUniversalTicket logs:\n" + e.logs.join("\n"));
            }
            throw e;
        }
    };

    it("arrange: create Buy order 10 USDC (no lock on create)", async () => {
        const beforeFiat = await getTokenBalance(connection, fiatGuyAta);

        await (program.methods as any)
            .createUniversalOrder(orderId, usdc(10), toBN(2_000), false)
            .accounts({
                creator: fiatGuy.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: fiatGuyAta, // present but unused for Buy
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([fiatGuy, adminSigner])
            .rpc();

        const order = await getOrder();
        const vaultBal = await getVaultBal();
        const afterFiat = await getTokenBalance(connection, fiatGuyAta);
        expect(order.isSellOrder).to.eq(false);
        expect(Number(order.cryptoAmount)).to.eq(usdc(10).toNumber());
        expect(vaultBal).to.eq(0);
        expect(afterFiat).to.eq(beforeFiat);
    });

    it("act: 4 sellers fill and settle tickets to FiatGuy", async () => {
        // Target fills: 2.0, 2.5, 3.0, 2.2 = 9.7 USDC total
    const fills = [2.0, 2.5, 3.0, 2.2];

        // Important: respect cooldown since create_order also set last_action_ts
        await waitCooldown();

        const fiatBefore = await getTokenBalance(connection, fiatGuyAta);

        // Sellers 1..4 accept valid tickets (deposit tokens to vault)
        const ticketPdas: PublicKey[] = [];
        for (let i = 0; i < 4; i++) {
            const seller = sellers[i];
            const t = await acceptTicket(seller, i + 1, usdc(fills[i]));
            ticketPdas.push(t);
            await waitCooldown();
        }

        // Both parties sign for tickets 1..4 (buy order): Fiat must sign first by rule
        for (let i = 0; i < 4; i++) {
            await signTicketBy(fiatGuy, ticketPdas[i]);        // FiatGuy signs first
            await waitCooldown();
            await signTicketBy(sellers[i].kp, ticketPdas[i]);  // Seller signs second -> settles to FiatGuy ATA
            await waitCooldown();
        }

        const order = await getOrder();
        const filled = Number(order.filledAmount);
        const remaining = Number(order.cryptoAmount) - filled; // remaining_amount()
        expect(filled).to.eq(usdc(9.7).toNumber());
        expect(remaining).to.eq(usdc(0.3).toNumber());
        expect(Number(order.reservedAmount)).to.eq(0);

        // Vault should be empty after settlements (all accepted tickets settled out)
        const vaultBal = await getVaultBal();
        expect(vaultBal).to.eq(0);

        // FiatGuy should have gained 9.7 less 0.2% fees per ticket
        const fiatAfter = await getTokenBalance(connection, fiatGuyAta);
        const fees = [2.0, 2.5, 3.0, 2.2].map(x => Math.floor(usdc(x).toNumber() * 20 / 10_000));
        const totalFee = fees.reduce((a, b) => a + b, 0);
        const expectedNet = usdc(9.7).toNumber() - totalFee;
        expect(fiatAfter - fiatBefore).to.eq(expectedNet);
    });

    it("assert: close with dust (no transfer) and closes the order", async () => {
        // For Buy order: no remainder in vault and no transfer on close
        await waitCooldown();
        await (program.methods as any)
            .closeUniversalOrder()
            .accounts({
                closer: fiatGuy.publicKey,
                adminRentReceiver: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                creatorTokenAccount: fiatGuyAta,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([fiatGuy])
            .rpc();

        // Fetching the order should now fail (account closed)
        let closed = false;
        try { await getOrder(); } catch { closed = true; }
        expect(closed).to.eq(true);
    });

    // Cleanup tokens back to main wallet
    after("return tokens back to main wallet", async function () {
        this.timeout(30000);
        try {
            if (!tokenSetup) return;
            const payer = provider.wallet.payer as Keypair;
            const mainAtaInfo = await getOrCreateAssociatedTokenAccount(
                connection, payer, tokenSetup.mint, payer.publicKey
            );
            const mainAta = mainAtaInfo.address;
            const all = [ { label: "Buyer", owner: fiatGuy, ata: fiatGuyAta }, ...sellers.map((s, i) => ({ label: `Seller${i+1}` , owner: s.kp, ata: s.ata })) ];
            for (const u of all) {
                try {
                    const bal = await getTokenBalance(connection, u.ata);
                    if (bal > 0) {
                        await transfer(connection, payer, u.ata, mainAta, u.owner, bal);
                    }
                } catch {}
            }
        } catch {}
    });
});


describe("🧾 Universal Orders: sign flow end-to-end", () => {
    const { connection, provider, program } = setupAnchorEnvironment();

    const toBN = (n: number) => new anchor.BN(n);
    const usdc = (n: number) => new anchor.BN(Math.round(n * 1_000_000));

    type Party = { kp: Keypair; ata: PublicKey };

    let tokenSetup: TestTokenSetup;
    let cryptoGuy: Party;
    let fiatGuy: Party;
    let adminTokenAccount: PublicKey;

    // Use the admin keypair from ENV config
    const adminSigner = TEST_WALLETS.buyer;

    before("setup fresh mint + users", async () => {
        await checkDonorBalance(connection);
        const seller = Keypair.generate();
        const buyer = Keypair.generate();
        const env = await setupTestEnvironment(
            connection,
            provider.wallet.payer as Keypair,
            [seller, buyer],
            TEST_TOKEN_AMOUNT_100,
            6
        );
        tokenSetup = env.tokenSetup;
        cryptoGuy = { kp: seller, ata: env.userAccounts[0].tokenAccount };
        fiatGuy   = { kp: buyer,  ata: env.userAccounts[1].tokenAccount };

        // Create admin token account for fees
        const adminAtaInfo = await getOrCreateAssociatedTokenAccount(
            connection,
            provider.wallet.payer as Keypair,
            tokenSetup.mint,
            adminSigner.publicKey
        );
        adminTokenAccount = adminAtaInfo.address;
    });

    const deriveOrderAndVault = (creator: PublicKey, orderId: anchor.BN) => {
        const orderSeed = Buffer.from("universal_order");
        const vaultSeed = Buffer.from("vault");
        const orderIdBuf = orderId.toArrayLike(Buffer, "le", 8);
        const [orderPda] = PublicKey.findProgramAddressSync(
            [orderSeed, creator.toBuffer(), tokenSetup.mint.toBuffer(), orderIdBuf],
            program.programId,
        );
        const [vaultPda] = PublicKey.findProgramAddressSync(
            [vaultSeed, orderPda.toBuffer()],
            program.programId,
        );
        return { orderPda, vaultPda };
    };

    const ticketPdaFor = (order: PublicKey, id: number) =>
        PublicKey.findProgramAddressSync([
            Buffer.from("ticket"), order.toBuffer(), toBN(id).toArrayLike(Buffer, "le", 8)
        ], program.programId)[0];

    it("Sell owner: fiat signs first, then crypto signs; tokens settle to FiatGuy", async () => {
        const amount = usdc(10);
        const orderId = toBN(Date.now() + 7001);
        const { orderPda, vaultPda } = deriveOrderAndVault(cryptoGuy.kp.publicKey, orderId);

        // Ensure seller has enough tokens
        const sellerBal = await getTokenBalance(connection, cryptoGuy.ata);
        if (sellerBal < amount.toNumber()) {
            await mintMoreTokens(connection, provider.wallet.payer as Keypair, cryptoGuy.ata, tokenSetup, amount.toNumber());
        }

        // Create sell order and lock tokens
        await (program.methods as any)
            .createUniversalOrder(orderId, amount, toBN(1_000), true)
            .accounts({
                creator: cryptoGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: cryptoGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([cryptoGuy.kp, adminSigner])
            .rpc();

        await waitForCooldown();

        // FiatGuy accepts full amount
        const ticketId = 1;
        const ticketPda = ticketPdaFor(orderPda, ticketId);
        await (program.methods as any)
            .acceptUniversalTicket(toBN(ticketId), amount)
            .accounts({
                acceptor: fiatGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([fiatGuy.kp, adminSigner])
            .rpc();

        // Fiat signs first
        const fiatBefore = await getTokenBalance(connection, fiatGuy.ata);
        const ticketData5 = await program.account.fillTicket.fetch(ticketPda);
        await (program.methods as any)
            .signUniversalTicket()
            .accounts({
                signer: fiatGuy.kp.publicKey,
                adminRentReceiver: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptor: ticketData5.acceptor,
                fiatGuyTokenAccount: fiatGuy.ata,
                adminFeeAccount: adminTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([fiatGuy.kp])
            .rpc();

        // Assert flags after first signature
        const afterFiatSign = await program.account.fillTicket.fetch(ticketPda);
        expect(afterFiatSign.fiatGuySigned).to.eq(true);
        expect(afterFiatSign.cryptoGuySigned).to.eq(false);

        // Capture admin fee account before settlement
        const adminBefore1 = await getTokenBalance(connection, adminTokenAccount);

        // Crypto signs second -> settlement
        await (program.methods as any)
            .signUniversalTicket()
            .accounts({
                signer: cryptoGuy.kp.publicKey,
                adminRentReceiver: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptor: ticketData5.acceptor,
                fiatGuyTokenAccount: fiatGuy.ata,
                adminFeeAccount: adminTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([cryptoGuy.kp])
            .rpc();

        const fiatAfter = await getTokenBalance(connection, fiatGuy.ata);
        const vaultAfter = await getTokenBalance(connection, vaultPda);
        const expectedFee1 = Math.floor(amount.toNumber() * 20 / 10_000);
        const expectedNet1 = amount.toNumber() - expectedFee1;
        expect(fiatAfter - fiatBefore).to.eq(expectedNet1);
        const adminAfter1 = await getTokenBalance(connection, adminTokenAccount);
        expect(adminAfter1 - adminBefore1).to.eq(expectedFee1);
        expect(vaultAfter).to.eq(0);

        const orderAcc = await (program.account as any).universalOrder.fetch(orderPda);
        expect(Number(orderAcc.filledAmount)).to.eq(amount.toNumber());
        expect(Number(orderAcc.reservedAmount)).to.eq(0);
    });

    it("Buy owner: seller accepts, fiat signs first (assert), then crypto signs; tokens settle to FiatGuy", async () => {
        const amount = usdc(10);
        const orderId = toBN(Date.now() + 7002);
        const { orderPda, vaultPda } = deriveOrderAndVault(fiatGuy.kp.publicKey, orderId);

        // Create buy order (no lock on create)
        await (program.methods as any)
            .createUniversalOrder(orderId, amount, toBN(2_000), false)
            .accounts({
                creator: fiatGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([fiatGuy.kp, adminSigner])
            .rpc();

        await waitForCooldown();

        // CryptoGuy accepts -> tokens move into vault
        const ticketId = 1;
        const ticketPda = ticketPdaFor(orderPda, ticketId);
        const sellerBefore = await getTokenBalance(connection, cryptoGuy.ata);
        const vaultBefore = await getTokenBalance(connection, vaultPda);
        await (program.methods as any)
            .acceptUniversalTicket(toBN(ticketId), amount)
            .accounts({
                acceptor: cryptoGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptorTokenAccount: cryptoGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([cryptoGuy.kp, adminSigner])
            .rpc();
        const sellerAfter = await getTokenBalance(connection, cryptoGuy.ata);
        const vaultAfterAccept = await getTokenBalance(connection, vaultPda);
        expect(sellerBefore - sellerAfter).to.eq(amount.toNumber());
        expect(vaultAfterAccept - vaultBefore).to.eq(amount.toNumber());

        // Fiat signs first (assert this state)
        const fiatBefore = await getTokenBalance(connection, fiatGuy.ata);
        const ticketData6 = await program.account.fillTicket.fetch(ticketPda);
        await (program.methods as any)
            .signUniversalTicket()
            .accounts({
                signer: fiatGuy.kp.publicKey,
                adminRentReceiver: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptor: ticketData6.acceptor,
                fiatGuyTokenAccount: fiatGuy.ata,
                adminFeeAccount: adminTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([fiatGuy.kp])
            .rpc();

        const afterFiatSign = await program.account.fillTicket.fetch(ticketPda);
        expect(afterFiatSign.fiatGuySigned).to.eq(true);
        expect(afterFiatSign.cryptoGuySigned).to.eq(false);

        // Capture admin fee account before settlement
        const adminBefore2 = await getTokenBalance(connection, adminTokenAccount);

        // Then crypto signs -> settlement to FiatGuy
        await (program.methods as any)
            .signUniversalTicket()
            .accounts({
                signer: cryptoGuy.kp.publicKey,
                adminRentReceiver: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptor: ticketData6.acceptor,
                fiatGuyTokenAccount: fiatGuy.ata,
                adminFeeAccount: adminTokenAccount,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([cryptoGuy.kp])
            .rpc();

        const fiatAfter = await getTokenBalance(connection, fiatGuy.ata);
        const vaultAfter = await getTokenBalance(connection, vaultPda);
        const expectedFee2 = Math.floor(amount.toNumber() * 20 / 10_000);
        const expectedNet2 = amount.toNumber() - expectedFee2;
        expect(fiatAfter - fiatBefore).to.eq(expectedNet2);
        const adminAfter2 = await getTokenBalance(connection, adminTokenAccount);
        expect(adminAfter2 - adminBefore2).to.eq(expectedFee2);
        expect(vaultAfter).to.eq(0);

        const orderAcc = await (program.account as any).universalOrder.fetch(orderPda);
        expect(Number(orderAcc.filledAmount)).to.eq(amount.toNumber());
        expect(Number(orderAcc.reservedAmount)).to.eq(0);
    });

    it("Sell owner: CryptoGuy tries to sign before FiatGuy -> error", async () => {
        const amount = usdc(10);
        const orderId = toBN(Date.now() + 7003);
        const { orderPda, vaultPda } = deriveOrderAndVault(cryptoGuy.kp.publicKey, orderId);

        // Ensure seller has enough tokens
        const sellerBal = await getTokenBalance(connection, cryptoGuy.ata);
        if (sellerBal < amount.toNumber()) {
            await mintMoreTokens(connection, provider.wallet.payer as Keypair, cryptoGuy.ata, tokenSetup, amount.toNumber());
        }

        await (program.methods as any)
            .createUniversalOrder(orderId, amount, toBN(1_000), true)
            .accounts({
                creator: cryptoGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: cryptoGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([cryptoGuy.kp, adminSigner])
            .rpc();

        await waitForCooldown();

        const ticketId = 2;
        const ticketPda = ticketPdaFor(orderPda, ticketId);
        await (program.methods as any)
            .acceptUniversalTicket(toBN(ticketId), amount)
            .accounts({
                acceptor: fiatGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([fiatGuy.kp, adminSigner])
            .rpc();

        // Attempt crypto sign first -> expect SignatureRequired
        try {
            const ticketData7 = await program.account.fillTicket.fetch(ticketPda);
            await (program.methods as any)
                .signUniversalTicket()
                .accounts({
                    signer: cryptoGuy.kp.publicKey,
                    adminRentReceiver: adminSigner.publicKey,
                    order: orderPda,
                    vault: vaultPda,
                    ticket: ticketPda,
                    acceptor: ticketData7.acceptor,
                    fiatGuyTokenAccount: fiatGuy.ata,
                    adminFeeAccount: adminTokenAccount,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([cryptoGuy.kp])
                .rpc();
            expect.fail("Crypto first sign should fail with SignatureRequired");
        } catch (e: any) {
            const msg = e?.message || "";
            const logs = e?.logs?.join("\n") || "";
            expect(msg.includes("SignatureRequired") || logs.includes("SignatureRequired")).to.eq(true);
        }
    });

    it("Buy owner: CryptoGuy tries to sign before FiatGuy -> error", async () => {
        const amount = usdc(10);
        const orderId = toBN(Date.now() + 7004);
        const { orderPda, vaultPda } = deriveOrderAndVault(fiatGuy.kp.publicKey, orderId);

        await (program.methods as any)
            .createUniversalOrder(orderId, amount, toBN(2_000), false)
            .accounts({
                creator: fiatGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                mint: tokenSetup.mint,
                vault: vaultPda,
                creatorTokenAccount: fiatGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([fiatGuy.kp, adminSigner])
            .rpc();

        await waitForCooldown();

        const ticketId = 2;
        const ticketPda = ticketPdaFor(orderPda, ticketId);
        // Seller accepts, moving tokens into vault
        await (program.methods as any)
            .acceptUniversalTicket(toBN(ticketId), amount)
            .accounts({
                acceptor: cryptoGuy.kp.publicKey,
                feePayer: adminSigner.publicKey,
                order: orderPda,
                vault: vaultPda,
                ticket: ticketPda,
                acceptorTokenAccount: cryptoGuy.ata,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([cryptoGuy.kp, adminSigner])
            .rpc();

        // Attempt crypto sign first -> expect SignatureRequired
        try {
            const ticketData8 = await program.account.fillTicket.fetch(ticketPda);
            await (program.methods as any)
                .signUniversalTicket()
                .accounts({
                    signer: cryptoGuy.kp.publicKey,
                    adminRentReceiver: adminSigner.publicKey,
                    order: orderPda,
                    vault: vaultPda,
                    ticket: ticketPda,
                    acceptor: ticketData8.acceptor,
                    fiatGuyTokenAccount: fiatGuy.ata,
                    adminFeeAccount: adminTokenAccount,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([cryptoGuy.kp])
                .rpc();
            expect.fail("Crypto first sign should fail with SignatureRequired (Buy)");
        } catch (e: any) {
            const msg = e?.message || "";
            const logs = e?.logs?.join("\n") || "";
            expect(msg.includes("SignatureRequired") || logs.includes("SignatureRequired")).to.eq(true);
        }
    });
});
