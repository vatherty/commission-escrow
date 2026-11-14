import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as schema from "../server/src/schema";
import { ensureLaunchInvites } from "../server/src/seed-content";
import { OWNER_EMAIL, PASSWORD, TestClient, makeServer, type TestServer } from "./helpers";

/* Trust Pool + refund-debt + moderator appointment/refusals (plan §9.4):
   a provable scam is covered instantly, the covered amount becomes the
   seller's refund balance, the balance blocks new work until the owner
   clears it, and a moderator holds the day-to-day set only — never
   invites, roles, debt, covers, grants or verify. */

let srv: TestServer;
let codes: string[] = [];
let owner: TestClient, buyer: TestClient, scammer: TestClient, mod: TestClient;
let scammerId = "", modId = "";
let jobId = "", job2Id = "";

beforeAll(async () => {
  srv = await makeServer();
  codes = (await ensureLaunchInvites(srv.handle.db)).codes;
  owner = new TestClient(srv.handler);
  buyer = new TestClient(srv.handler);
  scammer = new TestClient(srv.handler);
  mod = new TestClient(srv.handler);
  await owner.call("signUp", { displayName: "Owner", username: "owner", email: OWNER_EMAIL, password: PASSWORD, accountType: "buyer", over18: true, inviteCode: "", fingerprint: "" });
  await buyer.call("signUp", { displayName: "Buyer", username: "buyer", email: "buyer@example.com", password: PASSWORD, accountType: "buyer", over18: true, inviteCode: codes[0], fingerprint: "" });
  const s = await scammer.call("signUp", { displayName: "Scammy", username: "scammy", email: "scam@example.com", password: PASSWORD, accountType: "creator", shopName: "Scam Shop", over18: true, inviteCode: codes[1], fingerprint: "" });
  scammerId = s.account.id;
  const m = await mod.call("signUp", { displayName: "Mod", username: "moduser", email: "mod@example.com", password: PASSWORD, accountType: "buyer", over18: true, inviteCode: codes[2], fingerprint: "" });
  modId = m.account.id;
});

describe("trust pool cover + refund debt", () => {
  test("setup: external-rail job reaches deposit_paid, second job waits at brief", async () => {
    const j = await buyer.call("createCommission", { creatorId: "scam-shop", buyerName: "Buyer", title: "Too-good offer", brief: "A suspiciously cheap full painting.", budget: 50, kind: "standard", revisionsTotal: 2, payMethod: "external" });
    jobId = j.id;
    const j2 = await buyer.call("createCommission", { creatorId: "scam-shop", buyerName: "Buyer", title: "Second order", brief: "Another piece from the same shop.", budget: 40, kind: "standard", revisionsTotal: 2, payMethod: "external" });
    job2Id = j2.id;
    await scammer.call("milestoneAct", { id: jobId, action: "quote", quotePrice: 50, depositAmount: 25 });
    await scammer.call("milestoneAct", { id: jobId, action: "confirmDeposit" });
    const state = await buyer.call("getState", {});
    expect(state.commissions.find((c: any) => c.id === jobId).status).toBe("deposit_paid");
  });

  test("buyer walks away after the deadline passes", async () => {
    await srv.handle.db.update(schema.commissions).set({ deadline: new Date(Date.now() - 3600_000) }).where(eq(schema.commissions.id, jobId));
    await buyer.call("milestoneAct", { id: jobId, action: "walkAway" });
    const state = await buyer.call("getState", {});
    expect(state.commissions.find((c: any) => c.id === jobId).status).toBe("walked_away");
    const admin = await owner.call("adminGetState", {});
    expect(admin.refundJobs.some((j: any) => j.id === jobId && !j.covered)).toBe(true);
  });

  test("owner covers instantly: buyer paid, seller carries the debt, doors lock", async () => {
    const before = await buyer.refreshSession();
    await owner.call("adminCoverRefund", { commissionId: jobId, amount: 25 });
    const after = await buyer.refreshSession();
    expect(after.account.credits).toBe(before.account.credits + 25);
    /* A cover is compensation, not earnings: lifetime standing unmoved. */
    expect(after.account.lifetimeEarned).toBe(before.account.lifetimeEarned);
    const scamSession = await scammer.refreshSession();
    expect(scamSession.account.refundDebt).toBe(25);
    const newJob = await buyer.callErr("createCommission", { creatorId: "scam-shop", buyerName: "Buyer", title: "Third order", brief: "Trying to order again here.", budget: 30, kind: "standard", revisionsTotal: 2, payMethod: "external" });
    expect(newJob).toContain("outstanding refund balance");
    const quote = await scammer.callErr("milestoneAct", { id: job2Id, action: "quote", quotePrice: 40, depositAmount: 20 });
    expect(quote).toContain("outstanding refund balance");
    /* One cover per job, ever. */
    const again = await owner.callErr("adminCoverRefund", { commissionId: jobId, amount: 25 });
    expect(again).toContain("already covered");
  });

  test("owner clears the debt and the doors reopen", async () => {
    await owner.call("adminClearRefundDebt", { accountId: scammerId });
    const scamSession = await scammer.refreshSession();
    expect(scamSession.account.refundDebt).toBe(0);
    await scammer.call("milestoneAct", { id: job2Id, action: "quote", quotePrice: 40, depositAmount: 20 });
  });
});

describe("moderator appointment + refusals", () => {
  test("appointing a mod revokes their existing sessions (privilege rotation)", async () => {
    const before = await mod.refreshSession();
    expect(before.account?.username).toBe("moduser");
    await owner.call("adminSetRole", { accountId: modId, role: "mod" });
    const after = await mod.refreshSession();
    expect(after.account).toBe(null);
    const relogin = await mod.call("logIn", { email: "mod@example.com", password: PASSWORD });
    expect(relogin.account.role).toBe("mod");
  });

  test("mod refusals: the dev-only set stays shut", async () => {
    const attempts: [string, Record<string, unknown>][] = [
      ["adminGenerateInvite", { maxUses: 1 }],
      ["adminDisableInvite", { inviteId: "inv_whatever" }],
      ["adminSetRole", { accountId: scammerId, role: "member" }],
      ["adminCoverRefund", { commissionId: jobId, amount: 1 }],
      ["adminRecordRefundDebt", { accountId: scammerId, amount: 1 }],
      ["adminClearRefundDebt", { accountId: scammerId }],
      ["adminGrantCredits", { accountId: scammerId, amount: 10 }],
      ["adminSetVerified", { accountId: scammerId, verified: true }],
      ["adminRunGhostCheck", {}],
    ];
    for (const [action, args] of attempts) {
      const msg = await mod.callErr(action, args);
      expect(msg).toBe("That page couldn't be found.");
    }
  });

  test("mod CAN read the staff bundle — but the invite list stays dev-only", async () => {
    const admin = await mod.call("adminGetState", {});
    expect(admin.invites).toEqual([]);
    expect(admin.accounts.length).toBeGreaterThan(0);
    expect(admin.reports).toBeDefined();
  });

  test("mod CAN work the day-to-day queue (report dismiss)", async () => {
    const anon = new TestClient(srv.handler);
    const rep = await anon.call("createReport", { targetType: "creator", targetId: "scam-shop", itemTitle: "", reason: "Spam or scam", detail: "Took a deposit and vanished." });
    await mod.call("adminDismissReport", { reportId: rep.id });
    const admin = await owner.call("adminGetState", {});
    expect(admin.reports.find((r: any) => r.id === rep.id).status).toBe("dismissed");
    expect(admin.log.some((l: any) => l.action === "report_dismissed" && l.actorLabel === "@moduser")).toBe(true);
  });
});
