import * as anchor from "@coral-xyz/anchor";

export async function parseEvents<I extends anchor.Idl>(
    program: anchor.Program<I>,
    connection: anchor.web3.Connection,
    sig: string,
) {
    const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");

    await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed",
    );

    const tx = await connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
    });
    if (!tx) return [];

    const parser = new anchor.EventParser(
        program.programId,
        new anchor.BorshCoder(program.idl),
    );
    return [...parser.parseLogs(tx.meta!.logMessages!)];
}
