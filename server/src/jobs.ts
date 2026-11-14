import { and, eq, lt, or } from "drizzle-orm";
import * as schema from "./schema";
import type { Db } from "./db";

/* jobs:tick — the cron-able background pass (plan Step 7). Idempotent:
   the ghost scan only touches jobs still flagged unreleased with zero
   downloads (and re-checks with a conditional update), session/attempt
   cleanup deletes only rows already past their lifetime, and every run
   records exactly one background_job_runs row. Safe to run every 5
   minutes; safe to run twice. */

export interface TickCounts {
  ghostMarked: number;
  sessionsDeleted: number;
  loginAttemptsDeleted: number;
}

const DAY_MS = 24 * 3600 * 1000;

export async function runJobsTick(db: Db): Promise<TickCounts> {
  const startedAt = new Date();
  const runRows = await db.insert(schema.backgroundJobRuns).values({ kind: "tick", startedAt }).returning({ id: schema.backgroundJobRuns.id });
  const runId = runRows[0]?.id;
  try {
    const counts = await db.transaction(async (tx) => {
      let ghostMarked = 0;
      /* Ghost release: v2 jobs unlocked 7+ days ago whose buyer never
         downloaded the original are marked released-by-platform — the
         same scan adminRunGhostCheck runs by hand, here with the system
         as the actor. */
      const cutoff = Date.now() - 7 * DAY_MS;
      const unlocked = await tx.select().from(schema.commissions).where(eq(schema.commissions.status, "unlocked"));
      for (const c of unlocked) {
        if (c.ghostReleased === 1 || (c.downloadCount ?? 0) > 0 || !c.unlockedAt || c.unlockedAt.getTime() > cutoff) continue;
        const updated = await tx.update(schema.commissions)
          .set({ ghostReleased: 1, updatedAt: new Date() })
          .where(and(eq(schema.commissions.id, c.id), eq(schema.commissions.ghostReleased, 0)))
          .returning({ id: schema.commissions.id });
        if (updated.length === 0) continue;
        await tx.insert(schema.ledgerEntries).values({ commissionId: c.id, label: "Released by platform (ghost release)", fromState: "Unlocked", toState: "Unlocked", amount: 0, note: "Balance was confirmed paid, the file unlocked, and 7 days passed with no download — the platform records the delivery as released under the ghost-delivery licence. The original remains downloadable by the buyer of record." });
        await tx.insert(schema.moderationLog).values({ actorId: "system", actorLabel: "system (jobs:tick)", action: "ghost_release", targetType: "commission", targetId: c.id, note: `"${c.title}" marked released-by-platform (unlocked 7+ days, never downloaded)` });
        ghostMarked += 1;
      }
      /* Expired sessions: past absolute expiry OR past the 7-day idle
         window (resolveSession also deletes these on sight; this sweep
         keeps the table clean for accounts that never come back). */
      const now = new Date();
      const idleCutoff = new Date(Date.now() - 7 * DAY_MS);
      const delSessions = await tx.delete(schema.sessions)
        .where(or(lt(schema.sessions.expiresAt, now), lt(schema.sessions.lastSeenAt, idleCutoff)))
        .returning({ token: schema.sessions.token });
      /* Stale login attempts: the throttle window is 15 minutes; rows
         older than a day are pure history. */
      const attemptCutoff = new Date(Date.now() - DAY_MS);
      const delAttempts = await tx.delete(schema.loginAttempts)
        .where(lt(schema.loginAttempts.createdAt, attemptCutoff))
        .returning({ id: schema.loginAttempts.id });
      return { ghostMarked, sessionsDeleted: delSessions.length, loginAttemptsDeleted: delAttempts.length };
    });
    if (runId !== undefined) {
      await db.update(schema.backgroundJobRuns)
        .set({ finishedAt: new Date(), countsJson: JSON.stringify(counts) })
        .where(eq(schema.backgroundJobRuns.id, runId));
    }
    return counts;
  } catch (e) {
    if (runId !== undefined) {
      await db.update(schema.backgroundJobRuns)
        .set({ finishedAt: new Date(), error: e instanceof Error ? e.message : String(e) })
        .where(eq(schema.backgroundJobRuns.id, runId));
    }
    throw e;
  }
}

/* CLI entry: `bun run jobs:tick` (Render cron). Applies migrations first
   so a fresh database ticks cleanly, runs one pass, prints the counts,
   and exits — 0 on success (including an empty database), 1 on error. */
if (import.meta.main) {
  const { getDb } = await import("./db");
  const { applyMigrations } = await import("../../scripts/migrate-lib");
  const handle = await getDb();
  try {
    await applyMigrations(handle);
    const counts = await runJobsTick(handle.db);
    console.log(`jobs:tick ok — ghost marked: ${counts.ghostMarked}, sessions deleted: ${counts.sessionsDeleted}, login attempts deleted: ${counts.loginAttemptsDeleted}`);
    await handle.close();
    process.exit(0);
  } catch (e) {
    console.error("jobs:tick FAILED:", e instanceof Error ? e.message : e);
    await handle.close().catch(() => {});
    process.exit(1);
  }
}
