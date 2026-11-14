import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as schema from "../server/src/schema";
import { createTestDb } from "../server/src/db";
import { runJobsTick } from "../server/src/jobs";

/* jobs:tick (plan Step 7): ghost release + cleanups, idempotent, clean
   on an empty database, one background_job_runs row per run. */

describe("jobs:tick", () => {
  test("empty database ticks cleanly and records the run", async () => {
    const handle = await createTestDb();
    const counts = await runJobsTick(handle.db);
    expect(counts).toEqual({ ghostMarked: 0, sessionsDeleted: 0, loginAttemptsDeleted: 0 });
    const runs = await handle.db.select().from(schema.backgroundJobRuns);
    expect(runs.length).toBe(1);
    expect(runs[0]?.finishedAt).toBeTruthy();
    expect(runs[0]?.error).toBe("");
    await handle.close();
  });

  test("ghost release marks once; second tick is a no-op for that job", async () => {
    const handle = await createTestDb();
    const db = handle.db;
    await db.insert(schema.creators).values({ id: "ghost-shop", name: "Ghost Shop", handle: "@ghost", tagline: "", accent: "#888888", bio: "", status: "open", turnaround: "", pricesJson: "[]", willDoJson: "[]", wontDoJson: "[]", portfolioJson: "[]" });
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    await db.insert(schema.commissions).values({ id: "comm_ghost", creatorId: "ghost-shop", buyerName: "B", title: "Ghosted job", brief: "", refsText: "", budget: 50, price: 50, kind: "standard", rail: "reserve", status: "unlocked", v2: 1, unlockedAt: eightDaysAgo, downloadCount: 0, ghostReleased: 0 });
    await db.insert(schema.commissions).values({ id: "comm_downloaded", creatorId: "ghost-shop", buyerName: "B", title: "Downloaded job", brief: "", refsText: "", budget: 50, price: 50, kind: "standard", rail: "reserve", status: "unlocked", v2: 1, unlockedAt: eightDaysAgo, downloadCount: 1, ghostReleased: 0 });
    await db.insert(schema.commissions).values({ id: "comm_recent", creatorId: "ghost-shop", buyerName: "B", title: "Recent job", brief: "", refsText: "", budget: 50, price: 50, kind: "standard", rail: "reserve", status: "unlocked", v2: 1, unlockedAt: new Date(), downloadCount: 0, ghostReleased: 0 });

    const first = await runJobsTick(db);
    expect(first.ghostMarked).toBe(1);
    const ghost = await db.select().from(schema.commissions).where(eq(schema.commissions.id, "comm_ghost"));
    expect(ghost[0]?.ghostReleased).toBe(1);
    const downloaded = await db.select().from(schema.commissions).where(eq(schema.commissions.id, "comm_downloaded"));
    expect(downloaded[0]?.ghostReleased).toBe(0);
    const ledger = await db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.commissionId, "comm_ghost"));
    expect(ledger.some(l => l.label === "Released by platform (ghost release)")).toBe(true);
    const log = await db.select().from(schema.moderationLog).where(eq(schema.moderationLog.action, "ghost_release"));
    expect(log.length).toBe(1);
    expect(log[0]?.actorLabel).toBe("system (jobs:tick)");

    const second = await runJobsTick(db);
    expect(second.ghostMarked).toBe(0);
    const runs = await db.select().from(schema.backgroundJobRuns);
    expect(runs.length).toBe(2);
    await handle.close();
  });

  test("expired sessions and stale login attempts are swept", async () => {
    const handle = await createTestDb();
    const db = handle.db;
    await db.insert(schema.accounts).values({ id: "acct_sweep", displayName: "Sweep", username: "sweep", email: "sweep@example.com", passwordHash: "x", accountType: "buyer" });
    const longAgo = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    await db.insert(schema.sessions).values({ token: "expiredhash", accountId: "acct_sweep", expiresAt: longAgo, lastSeenAt: longAgo });
    await db.insert(schema.sessions).values({ token: "livehash", accountId: "acct_sweep", expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: new Date() });
    await db.insert(schema.loginAttempts).values({ email: "sweep@example.com", createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000) });
    await db.insert(schema.loginAttempts).values({ email: "sweep@example.com", createdAt: new Date() });
    const counts = await runJobsTick(db);
    expect(counts.sessionsDeleted).toBe(1);
    expect(counts.loginAttemptsDeleted).toBe(1);
    const sessions = await db.select().from(schema.sessions);
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.token).toBe("livehash");
    await handle.close();
  });
});
