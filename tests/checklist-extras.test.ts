import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as schema from "../server/src/schema";
import { ensureLaunchInvites } from "../server/src/seed-content";
import { BTC_ADDRESS, JPEG_BYTES, OWNER_EMAIL, PASSWORD, TestClient, makeServer, type TestServer } from "./helpers";

/* The remaining locally-checkable §9 items not covered by the other
   suites: §9.2 password policy + duplicates, §9.3 throttle + ban-kills-
   session + cookie flags, §9.4 member-vs-every-admin-action + owner
   protection + DTO hygiene, §9.5 revisions / deemed approval / escalate
   timing / verified-only, §9.6 simulated-subset items, §9.7 media caps
   + quarantine delivery, §9.8 ban effects + fingerprint flag + verify. */

let srv: TestServer;
let codes: string[] = [];
let owner: TestClient, artist: TestClient, artistB: TestClient, buyer: TestClient, buyer2: TestClient, member: TestClient;
let ownerId = "", buyerId = "", buyer2Id = "";
const NOT_FOUND = "That page couldn't be found.";
const THEME_BASE = { pfpUrl: "", bannerUrl: "", bgColor: "#fffef9", panelColor: "#ffffff", accent: "#e05260", accent2: "#facc15", headingColor: "#334155", bodyColor: "#475569", bgImageUrl: "", showcaseUrl: "", portfolioImages: {}, categories: [], paymentMethods: [], verifiedOnly: false };

async function externalJobTo(creatorId: string, stage: "quoted" | "deposit_paid" | "sketch_review" | "vault_delivered", who: { buyerC: TestClient; artistC: TestClient }): Promise<string> {
  const j = await who.buyerC.call("createCommission", { creatorId, buyerName: "Buyer", title: `Job to ${stage}`, brief: "A job walked to a specific stage.", budget: 60, kind: "standard", revisionsTotal: 1, payMethod: "external" });
  await who.artistC.call("milestoneAct", { id: j.id, action: "quote", quotePrice: 60, depositAmount: 30 });
  if (stage === "quoted") return j.id;
  await who.artistC.call("milestoneAct", { id: j.id, action: "confirmDeposit" });
  if (stage === "deposit_paid") return j.id;
  const sketchRef = await who.artistC.upload(new Blob([JPEG_BYTES], { type: "image/jpeg" }), "sketch");
  await who.artistC.call("milestoneAct", { id: j.id, action: "submitSketch", sketchImageUrl: sketchRef });
  if (stage === "sketch_review") return j.id;
  await who.buyerC.call("milestoneAct", { id: j.id, action: "approveSketch" });
  const vaultRef = await who.artistC.upload(new Blob([JPEG_BYTES], { type: "image/jpeg" }), "vault_original");
  const previewRef = await who.artistC.upload(new Blob([JPEG_BYTES], { type: "image/jpeg" }), "vault_preview");
  await who.artistC.call("milestoneAct", { id: j.id, action: "deliverVault", vaultFileUrl: vaultRef, vaultPreviewUrl: previewRef, vaultFileName: "final.jpg" });
  return j.id;
}

beforeAll(async () => {
  srv = await makeServer();
  codes = (await ensureLaunchInvites(srv.handle.db)).codes;
  owner = new TestClient(srv.handler);
  artist = new TestClient(srv.handler);
  artistB = new TestClient(srv.handler);
  buyer = new TestClient(srv.handler);
  buyer2 = new TestClient(srv.handler);
  member = new TestClient(srv.handler);
  const o = await owner.call("signUp", { displayName: "Owner", username: "owner", email: OWNER_EMAIL, password: PASSWORD, accountType: "buyer", over18: true, inviteCode: "", fingerprint: "" });
  ownerId = o.account.id;
  await artist.call("signUp", { displayName: "Artist", username: "artist", email: "artist@example.com", password: PASSWORD, accountType: "creator", shopName: "Extras Shop", over18: true, inviteCode: codes[0], fingerprint: "" });
  await artist.call("updateCreatorTheme", { ...THEME_BASE, creatorId: "extras-shop", cryptoWallets: [{ network: "btc", address: BTC_ADDRESS, label: "Bitcoin" }] });
  await artistB.call("signUp", { displayName: "ArtistB", username: "artistb", email: "artistb@example.com", password: PASSWORD, accountType: "creator", shopName: "Verified Only Shop", over18: true, inviteCode: codes[1], fingerprint: "" });
  const b = await buyer.call("signUp", { displayName: "Buyer", username: "buyer", email: "buyer@example.com", password: PASSWORD, accountType: "buyer", over18: true, inviteCode: codes[2], fingerprint: "" });
  buyerId = b.account.id;
  const b2 = await buyer2.call("signUp", { displayName: "BuyerTwo", username: "buyertwo", email: "buyer2@example.com", password: PASSWORD, accountType: "buyer", over18: true, inviteCode: codes[3], fingerprint: "fp-shared-device" });
  buyer2Id = b2.account.id;
  await member.call("signUp", { displayName: "Member", username: "member", email: "member@example.com", password: PASSWORD, accountType: "buyer", over18: true, inviteCode: codes[4], fingerprint: "" });
});

describe("§9.2 password policy + duplicates + starting standing", () => {
  test("short and common passwords are refused; duplicates get the current messages", async () => {
    const c = new TestClient(srv.handler);
    const short = await c.callErr("signUp", { displayName: "X", username: "shorty", email: "shorty@example.com", password: "short", accountType: "buyer", over18: true, inviteCode: codes[5], fingerprint: "" });
    expect(short).toContain("at least 15 characters");
    const common = await c.callErr("signUp", { displayName: "X", username: "commonpw", email: "common@example.com", password: "passwordpassword", accountType: "buyer", over18: true, inviteCode: codes[5], fingerprint: "" });
    expect(common).toContain("too well-known");
    const dupEmail = await c.callErr("signUp", { displayName: "X", username: "someoneelse", email: "buyer@example.com", password: PASSWORD, accountType: "buyer", over18: true, inviteCode: codes[5], fingerprint: "" });
    expect(dupEmail).toBe("That email already has an account — try logging in instead.");
    const dupName = await c.callErr("signUp", { displayName: "X", username: "buyer", email: "fresh@example.com", password: PASSWORD, accountType: "buyer", over18: true, inviteCode: codes[5], fingerprint: "" });
    expect(dupName).toBe("That username is taken — try a different one.");
    /* codes[5] survived all four failures — a failed signup never spends a code. */
    const ok = await c.call("signUp", { displayName: "Throttle", username: "throttle", email: "throttle@example.com", password: PASSWORD, accountType: "buyer", over18: true, inviteCode: codes[5], fingerprint: "" });
    expect(ok.account.credits).toBe(0);
    expect(ok.account.lifetimeEarned).toBe(0);
    expect(ok.account.level).toBe(1);
  });

  test("login throttle: five failures pause the gate, even for the right password", async () => {
    const c = new TestClient(srv.handler);
    for (let i = 0; i < 5; i++) {
      const msg = await c.callErr("logIn", { email: "throttle@example.com", password: "wrong password attempt" });
      expect(msg).toBe("That email and password don't match.");
    }
    const sixth = await c.callErr("logIn", { email: "throttle@example.com", password: PASSWORD });
    expect(sixth).toContain("breather");
  });

  test("session cookie flags (local config) + login mints a fresh session", async () => {
    const c = new TestClient(srv.handler);
    await c.refreshSession();
    const r = await c.raw("POST", "/api/rpc/logIn", { body: { email: "member@example.com", password: PASSWORD } });
    const setCookie = r.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("ce_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    const first = await c.refreshSession();
    expect(first.account?.username).toBe("member");
    await c.call("logOut", {});
    const c2 = new TestClient(srv.handler);
    await c2.call("logIn", { email: "member@example.com", password: PASSWORD });
    const second = await c2.refreshSession();
    expect(second.account?.username).toBe("member");
  });
});

describe("§9.4 member vs every admin action + owner protection + DTO hygiene", () => {
  test("a member is refused by all 16 admin actions, indistinguishably", async () => {
    const attempts: [string, Record<string, unknown>][] = [
      ["adminGetState", {}],
      ["adminGenerateInvite", { maxUses: 1 }],
      ["adminDisableInvite", { inviteId: "inv_x" }],
      ["adminQuarantine", { targetType: "post", targetId: "post_x" }],
      ["adminRestore", { targetType: "post", targetId: "post_x" }],
      ["adminDelete", { targetType: "post", targetId: "post_x" }],
      ["adminSetBan", { accountId: buyerId, banned: true }],
      ["adminGrantCredits", { accountId: buyerId, amount: 5 }],
      ["adminDismissReport", { reportId: "rep_x" }],
      ["adminSetVerified", { accountId: buyerId, verified: true }],
      ["adminAddStrike", { accountId: buyerId, note: "test strike" }],
      ["adminRunGhostCheck", {}],
      ["adminSetRole", { accountId: buyerId, role: "mod" }],
      ["adminRecordRefundDebt", { accountId: buyerId, amount: 5 }],
      ["adminClearRefundDebt", { accountId: buyerId }],
      ["adminCoverRefund", { commissionId: "comm_x", amount: 5 }],
    ];
    expect(attempts.length).toBe(16);
    for (const [action, args] of attempts) {
      expect(await member.callErr(action, args)).toBe(NOT_FOUND);
    }
  });

  test("the owner account cannot be banned and its role cannot be changed", async () => {
    expect(await owner.callErr("adminSetBan", { accountId: ownerId, banned: true })).toBe("The owner account can't be banned.");
    expect(await owner.callErr("adminSetRole", { accountId: ownerId, role: "member" })).toBe("The dev account's role is fixed — it's the dev account.");
  });

  test("public DTOs carry no emails, hashes, debt or session data", async () => {
    const anon = new TestClient(srv.handler);
    const state = await anon.call("getState", {});
    const search = await anon.call("searchCreators", { text: "", categories: [], matchMode: "any", sort: "relevance" });
    const feed = await anon.call("listPosts", { category: "" });
    const blob = JSON.stringify({ state, search, feed });
    expect(blob).not.toContain("passwordHash");
    expect(blob).not.toContain("@example.com");
    expect(blob).not.toContain("refundDebt");
    expect(blob).not.toContain("banEvasionFlag");
  });
});

describe("§9.5 revisions, deemed approval, escalate timing, verified-only", () => {
  test("a revision is consumed, then the resubmitted sketch can be approved", async () => {
    const jobId = await externalJobTo("extras-shop", "sketch_review", { buyerC: buyer, artistC: artist });
    await buyer.call("milestoneAct", { id: jobId, action: "requestRevision" });
    let state = await buyer.call("getState", {});
    let job = state.commissions.find((c: any) => c.id === jobId);
    expect(job.status).toBe("deposit_paid");
    expect(job.revisionsUsed).toBe(1);
    /* The brief allowed exactly 1 revision — a second is refused. */
    const sketchRef = await artist.upload(new Blob([JPEG_BYTES], { type: "image/jpeg" }), "sketch");
    await artist.call("milestoneAct", { id: jobId, action: "submitSketch", sketchImageUrl: sketchRef });
    const msg = await buyer.callErr("milestoneAct", { id: jobId, action: "requestRevision" });
    expect(msg).toContain("revisions from the brief are used up");
    await buyer.call("milestoneAct", { id: jobId, action: "approveSketch" });
    state = await buyer.call("getState", {});
    job = state.commissions.find((c: any) => c.id === jobId);
    expect(job.status).toBe("sketch_approved");
  });

  test("deemed approval: refused before 3 days of silence, succeeds after", async () => {
    const jobId = await externalJobTo("extras-shop", "sketch_review", { buyerC: buyer, artistC: artist });
    const early = await buyer.callErr("milestoneAct", { id: jobId, action: "deemedApprove" });
    expect(early).toContain("3 full days");
    await srv.handle.db.update(schema.commissions).set({ sketchSubmittedAt: new Date(Date.now() - 4 * 24 * 3600 * 1000) }).where(eq(schema.commissions.id, jobId));
    await buyer.call("milestoneAct", { id: jobId, action: "deemedApprove" });
    const state = await buyer.call("getState", {});
    expect(state.commissions.find((c: any) => c.id === jobId).status).toBe("sketch_approved");
  });

  test("escalate + withdraw are refused before 7 days unpaid", async () => {
    const jobId = await externalJobTo("extras-shop", "vault_delivered", { buyerC: buyer, artistC: artist });
    expect(await artist.callErr("milestoneAct", { id: jobId, action: "escalate" })).toContain("7 days");
    expect(await artist.callErr("milestoneAct", { id: jobId, action: "withdrawVault" })).toContain("7 days");
    await srv.handle.db.update(schema.commissions).set({ vaultDeliveredAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) }).where(eq(schema.commissions.id, jobId));
    await artist.call("milestoneAct", { id: jobId, action: "escalate" });
    const admin = await owner.call("adminGetState", {});
    expect(admin.refundJobs.some((j: any) => j.id === jobId && j.escalated)).toBe(true);
  });

  test("verify awards +20 exactly once; verified-only shop gates on it", async () => {
    await owner.call("adminSetVerified", { accountId: buyerId, verified: true });
    await owner.call("adminSetVerified", { accountId: buyerId, verified: true });
    const session = await buyer.refreshSession();
    expect(session.account.credits).toBe(20);
    expect(session.account.verified).toBe(true);
    await artistB.call("updateCreatorTheme", { ...THEME_BASE, creatorId: "verified-only-shop", cryptoWallets: [], verifiedOnly: true });
    const refused = await buyer2.callErr("createCommission", { creatorId: "verified-only-shop", buyerName: "BuyerTwo", title: "Please draw", brief: "An unverified buyer asking.", budget: 40, kind: "standard", revisionsTotal: 2, payMethod: "external" });
    expect(refused).toContain("verified buyers only");
    const ok = await buyer.call("createCommission", { creatorId: "verified-only-shop", buyerName: "Buyer", title: "Please draw", brief: "A verified buyer asking nicely.", budget: 40, kind: "standard", revisionsTotal: 2, payMethod: "external" });
    expect(ok.ok).toBe(true);
  });
});

describe("§9.6 simulated-checker subset", () => {
  test("unlisted rail refused; no-txid check refused; wrong-network txid shape refused; manual confirm refused on crypto", async () => {
    const unlisted = await buyer.callErr("createCommission", { creatorId: "extras-shop", buyerName: "Buyer", title: "LTC job", brief: "Trying a rail the artist lacks.", budget: 40, kind: "standard", revisionsTotal: 2, payMethod: "crypto:ltc" });
    expect(unlisted).toContain("isn't one this artist offers");
    const j = await buyer.call("createCommission", { creatorId: "extras-shop", buyerName: "Buyer", title: "BTC job", brief: "A bitcoin job for checker states.", budget: 40, kind: "standard", revisionsTotal: 2, payMethod: "crypto:btc" });
    await artist.call("milestoneAct", { id: j.id, action: "quote", quotePrice: 40, depositAmount: 20 });
    const noTx = await buyer.callErr("milestoneAct", { id: j.id, action: "checkDepositTx" });
    expect(noTx).toContain("No deposit transaction has been submitted yet");
    const wrongShape = await buyer.callErr("milestoneAct", { id: j.id, action: "submitDepositTx", txid: `0x${"a".repeat(64)}` });
    expect(wrongShape).toContain("transaction ID");
    const manual = await artist.callErr("milestoneAct", { id: j.id, action: "confirmDeposit" });
    expect(manual).toContain("transaction checker");
  });

  test("a seed-phrase-shaped wallet submission is rejected, nothing stored", async () => {
    const msg = await artist.callErr("updateCreatorTheme", { ...THEME_BASE, creatorId: "extras-shop", cryptoWallets: [{ network: "btc", address: "legal winner thank year wave sausage worth useful legal winner thank yellow", label: "bad" }] });
    expect(msg).toContain("seed phrase");
    const state = await buyer.call("getState", {});
    const shop = state.creators.find((c: any) => c.id === "extras-shop");
    expect(shop.cryptoWallets.length).toBe(1);
    expect(shop.cryptoWallets[0].address).toBe(BTC_ADDRESS);
  });
});

describe("§9.7 media caps + quarantine delivery", () => {
  test("oversized init, non-MP4 video, and fake image bytes are all refused", async () => {
    const big = await artist.raw("POST", "/api/uploads/init", { body: { kind: "profile", mimeType: "image/png", byteSize: 800_000 } });
    expect(big.status).toBe(400);
    const webm = await artist.raw("POST", "/api/uploads/init", { body: { kind: "post_video", mimeType: "video/webm", byteSize: 1000 } });
    expect(webm.status).toBe(400);
    expect(webm.data.error.message).toContain("MP4");
    const fakeRef = await artist.raw("POST", "/api/uploads/init", { body: { kind: "post_image", mimeType: "image/png", byteSize: 12 } });
    const put = await artist.raw("PUT", fakeRef.data.uploadPath, { rawBody: new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])], { type: "image/png" }), headers: { "Content-Type": "image/png" } });
    expect(put.status).toBe(200);
    const done = await artist.raw("POST", "/api/uploads/complete", { body: { assetId: fakeRef.data.assetId } });
    expect(done.status).toBe(400);
    expect(done.data.error.message).toContain("doesn't look like");
  });

  test("quarantine removes a post's media from delivery; restore brings it back, bytes unchanged", async () => {
    const ref = await artist.upload(new Blob([JPEG_BYTES], { type: "image/jpeg" }), "post_image");
    const assetId = ref.slice("asset:".length);
    const post = await artist.call("createPost", { title: "Quarantine target", body: "A post whose media gets quarantined.", priceNote: "", imageUrl: ref, videoUrl: "", categories: [] });
    const anon = new TestClient(srv.handler);
    const before = await anon.raw("GET", `/media/${assetId}`);
    expect(before.status).toBe(200);
    const assetBefore = (await srv.handle.db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, assetId)))[0];
    await owner.call("adminQuarantine", { targetType: "post", targetId: post.id, note: "test quarantine" });
    const during = await anon.raw("GET", `/media/${assetId}`);
    expect(during.status).toBe(404);
    await owner.call("adminRestore", { targetType: "post", targetId: post.id });
    const after = await anon.raw("GET", `/media/${assetId}`);
    expect(after.status).toBe(200);
    const assetAfter = (await srv.handle.db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, assetId)))[0];
    expect(assetAfter?.sha256).toBe(assetBefore?.sha256);
  });
});

describe("§9.8 ban effects + fingerprint tripwire", () => {
  test("ban kills the live session, blocks login, hides the account; unban restores login, not standing", async () => {
    const before = await buyer2.refreshSession();
    expect(before.account?.username).toBe("buyertwo");
    await owner.call("adminSetBan", { accountId: buyer2Id, banned: true });
    const after = await buyer2.refreshSession();
    expect(after.account).toBe(null);
    const login = await buyer2.callErr("logIn", { email: "buyer2@example.com", password: PASSWORD });
    expect(login).toContain("suspended");
    await owner.call("adminSetBan", { accountId: buyer2Id, banned: false });
    const relogin = await buyer2.call("logIn", { email: "buyer2@example.com", password: PASSWORD });
    expect(relogin.account.username).toBe("buyertwo");
  });

  test("a signup from a banned account's device is silently flagged, otherwise usable", async () => {
    await owner.call("adminSetBan", { accountId: buyer2Id, banned: true });
    const c = new TestClient(srv.handler);
    const r = await c.call("signUp", { displayName: "New Face", username: "newface", email: "newface@example.com", password: PASSWORD, accountType: "buyer", over18: true, inviteCode: codes[6], fingerprint: "fp-shared-device" });
    expect(r.account.username).toBe("newface");
    const admin = await owner.call("adminGetState", {});
    const flagged = admin.accounts.find((a: any) => a.username === "newface");
    expect(flagged.banEvasionFlag).toBe(true);
    const clean = admin.accounts.find((a: any) => a.username === "buyer");
    expect(clean.banEvasionFlag).toBe(false);
    await owner.call("adminSetBan", { accountId: buyer2Id, banned: false });
  });
});
