/**
 * Repair stuck PENDING withdrawals.
 *
 * Usage (from kaasupay-backend folder):
 *   node repair-stuck-withdrawals.js            -> DRY RUN, changes nothing
 *   node repair-stuck-withdrawals.js --apply    -> applies the proposed fixes
 *
 * It only touches withdrawals that are PENDING and whose payout job is
 * NEW with attempts 0 (i.e. nothing was ever sent to the bank).
 *
 * Fixes proposed per withdrawal:
 *   A. Link transactionId if it is missing and exactly ONE matching
 *      WITHDRAWAL transaction exists (same user, amount, +-10 min).
 *   B. Set the linked transaction back to PENDING if it says SUCCESS
 *      (the worker refuses to pay out unless it is PENDING/PROCESSING).
 *   C. Set the job's nextAttemptAt to now if the field is missing
 *      (the worker's query cannot match jobs without it).
 *
 * Anything ambiguous is only reported, never changed.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const {
    connectDB,
    Withdrawal,
    OutboxEvent,
    Transaction,
    LedgerEntry
} = require("./db");

const APPLY = process.argv.includes("--apply");
const WINDOW_MS = 10 * 60 * 1000;

async function main() {
    await connectDB(); // prints the database name and host: compare with deployed
    console.log(APPLY ? "\nMODE: APPLY\n" : "\nMODE: DRY RUN (no changes)\n");

    const withdrawals = await Withdrawal.find({ status: "PENDING" });
    console.log(`PENDING withdrawals found: ${withdrawals.length}\n`);

    for (const w of withdrawals) {
        console.log(`--- Withdrawal ${w._id} ref=${w.reference} amount=${w.amount} paise`);

        const job = await OutboxEvent.findOne({
            type: "PAYOUT_REQUESTED",
            withdrawalId: w._id
        });

        if (!job) {
            console.log("  ! No payout job exists. Report only; needs manual handling.\n");
            continue;
        }

        console.log(`  job: status=${job.status} attempts=${job.attempts} nextAttemptAt=${job.nextAttemptAt}`);

        if (job.status !== "NEW" || job.attempts !== 0) {
            console.log("  ! Job was already touched. Skipping (could have reached the bank).\n");
            continue;
        }

        const actions = [];
        let txId = w.transactionId;

        // A. missing transactionId
        if (!txId) {
            const candidates = await Transaction.find({
                type: "WITHDRAWAL",
                amount: w.amount,
                createdAt: {
                    $gte: new Date(w.createdAt.getTime() - WINDOW_MS),
                    $lte: new Date(w.createdAt.getTime() + WINDOW_MS)
                },
                $or: [{ fromUserId: w.userId }, { toUserId: w.userId }]
            });

            const free = [];
            for (const c of candidates) {
                const taken = await Withdrawal.exists({
                    transactionId: c._id,
                    _id: { $ne: w._id }
                });
                if (!taken) free.push(c);
            }

            if (free.length === 1) {
                txId = free[0]._id;
                actions.push({
                    label: `link transactionId -> ${txId}`,
                    run: () => Withdrawal.updateOne(
                        { _id: w._id, transactionId: null },
                        { $set: { transactionId: txId } }
                    )
                });
            } else {
                console.log(`  ! transactionId missing and ${free.length} candidate(s) found. Needs manual linking.\n`);
                continue;
            }
        }

        // B. transaction status
        const tx = await Transaction.findById(txId);
        if (!tx) {
            console.log("  ! Linked transaction not found. Manual review.\n");
            continue;
        }

        const ledger = await LedgerEntry.find({ transactionId: tx._id });
        console.log(`  transaction ${tx._id}: status=${tx.status}; ledger entries=${ledger.length}`);

        if (ledger.length === 0) {
            console.log("  ! No ledger entry: wallet may not have been debited. Manual review.\n");
            continue;
        }

        if (tx.status === "SUCCESS") {
            actions.push({
                label: "set transaction status SUCCESS -> PENDING",
                run: () => Transaction.updateOne(
                    { _id: tx._id, status: "SUCCESS", type: "WITHDRAWAL" },
                    { $set: { status: "PENDING" } }
                )
            });
        } else if (!["PENDING", "PROCESSING"].includes(tx.status)) {
            console.log(`  ! Transaction status ${tx.status}. Manual review.\n`);
            continue;
        }

        // C. missing nextAttemptAt
        const rawJob = await OutboxEvent.collection.findOne({ _id: job._id });
        if (!rawJob.nextAttemptAt) {
            actions.push({
                label: "set job nextAttemptAt = now (field was missing)",
                run: () => OutboxEvent.collection.updateOne(
                    { _id: job._id, nextAttemptAt: { $exists: false } },
                    { $set: { nextAttemptAt: new Date() } }
                )
            });
        }

        if (actions.length === 0) {
            console.log("  nothing to fix for this one.\n");
            continue;
        }

        for (const a of actions) {
            console.log(`  -> ${a.label}`);
            if (APPLY) {
                const r = await a.run();
                console.log(`     done (modified: ${r.modifiedCount ?? r.nModified ?? "?"})`);
            }
        }
        console.log("");
    }

    await mongoose.disconnect();
    console.log(APPLY ? "Finished." : "Dry run finished. Re-run with --apply to make these changes.");
}

main().catch(err => {
    console.error("Repair failed:", err);
    process.exit(1);
});