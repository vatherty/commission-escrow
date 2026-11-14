import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as schema from "../server/src/schema";
import { ensureLaunchInvites } from "../server/src/seed-content";
import { BTC_ADDRESS, JPEG_BYTES, OWNER_EMAIL, PASSWORD, TXID_1, TXID_2, TestClient, makeServer, type TestServer } from "./helpers";

/* Scripted end-to-end walk (plan §9): invite signup → owner born dev →
   crypto job Brief → Quote → deposit txid → simulated check → sketch →
   vault → balance txid → auto-unlock → buyer-only download. Standing
   totals are the golden numbers from the verified Space build:
   artist 85 (40 completion + 25 first job + 15 on-time + 5 clean
   sketch), buyer 40 (15 + 25). */

let srv: TestServer;
let codes: string[] = [];
let anon: TestClient, owner: TestClient, artist: TestClient, buyer: TestClient, unrelated: TestClient;
let jobId = "";
let vaultAssetId = "";

const THEME = {
  creatorId: "test-atelier", pfpUrl: "", bannerUrl: "", bgColor: "#fffef9", panelColor: "#ffffff",
  accent: "#e05260", accent2: "#facc15", headingColor: "#334155", bodyColor: "#475569",
  bgImageUrl: "", showcaseUrl: "", portfolioImages: {}, categories: [], paymentMethods: [],
  cryptoWallets: [{ network: "btc", address: BTC_ADDRESS, label: "Bitcoin" }], verifiedOnly: false,
};

beforeAll(async () => {
  srv = await makeServer();
  const inv = await ensureLaunchInvites(srv.handle.db);
  codes = inv.codes;
  expect(codes.length).toBe(10);
  anon = new TestClient(srv.handler);
  owner = new TestClient(srv.handler);
  artist = new TestClient(srv.handler);
  buyer = new TestClient(srv.handler);
  unrelated = new TestClient(srv.handler);
});

describe("accounts + invites", () => {
  test("owner signs up with NO invite code and is born dev", async () => {
    const r = await owner.call("signUp", { displayName: "Owner", username: "owner", email: OWNER_EMAIL, password: PASSWORD, accountType: "buyer", over18: true, inviteCode: "", fingerprint: "" });
    expect(r.account.role).toBe("dev");
    expect(r.account.isAdmin).toBe(true);
    const admin = await owner.call("adminGetState", {});
    expect(admin.invites.length).toBe(10);
  });

  test("signup with a bogus invite code is refused generically", async () => {
    const c = new TestClient(srv.handler);
    const msg = await c.callErr("signUp", { displayName: "Nope", username: "nope", email: "nope@example.com", password: PASSWORD, accountType: "buyer", over18: true, inviteCode: "XXXXX-XXXXX-XXXXX", fingerprint: "" });
    expect(msg).toBe("That invite code isn't valid.");
  });

  test("artist + buyer + unrelated sign up consuming single-use codes", async () => {
    const a = await artist.call("signUp", { displayName: "Artist", username: "artist", email: "artist@example.com", password: PASSWORD, accountType: "creator", shopName: "Test Atelier", over18: true, inviteCode: codes[0], fingerprint: "" });
    expect(a.account.creatorId).toBe("test-atelier");
    const b = await buyer.call("signUp", { displayName: "Buyer", username: "buyer", email: "buyer@example.com", password: PASSWORD, accountType: "buyer", over18: true, inviteCode: codes[1], fingerprint: "" });
    expect(b.account.role).toBe("member");
    await unrelated.call("signUp", { displayName: "Nosy", username: "nosy", email: "nosy@example.com", password: PASSWORD, accountType: "buyer", over18: true, inviteCode: codes[2], fingerprint: "" });
    /* The spent code can't be reused. */
    const c = new TestClient(srv.handler);
    const msg = await c.callErr("signUp", { displayName: "Copy", username: "copycat", email: "copy@example.com", password: PASSWORD, accountType: "buyer", over18: true, inviteCode: codes[0], fingerprint: "" });
    expect(msg).toBe("That invite code isn't valid.");
    const admin = await owner.call("adminGetState", {});
    expect(admin.invites.reduce((n: number, i: any) => n + i.usesCount, 0)).toBe(3);
  });

  test("artist lists a BTC wallet", async () => {
    const r = await artist.call("updateCreatorTheme", THEME);
    expect(r.ok).toBe(true);
    const state = await anon.call("getState", {});
    const shop = state.creators.find((c: any) => c.id === "test-atelier");
    expect(shop.cryptoWallets.length).toBe(1);
    expect(shop.cryptoWallets[0].address).toBe(BTC_ADDRESS);
  });
});

describe("crypto job walk", () => {
  test("buyer creates a v2 crypto brief; visibility follows the getState split", async () => {
    const r = await buyer.call("createCommission", { creatorId: "test-atelier", buyerName: "Buyer", title: "Portrait of my OC", brief: "A portrait of my original character, please.", budget: 70, kind: "standard", revisionsTotal: 2, payMethod: "crypto:btc" });
    jobId = r.id;
    expect(jobId).toBeTruthy();
    const mine = await buyer.call("getState", {});
    expect(mine.commissions.some((c: any) => c.id === jobId && c.status === "brief" && c.isV2)).toBe(true);
    const theirs = await artist.call("getState", {});
    expect(theirs.commissions.some((c: any) => c.id === jobId)).toBe(true);
    const publicView = await anon.call("getState", {});
    expect(publicView.commissions.some((c: any) => c.id === jobId)).toBe(false);
    const nosy = await unrelated.call("getState", {});
    expect(nosy.commissions.some((c: any) => c.id === jobId)).toBe(false);
    const staffView = await owner.call("getState", {});
    expect(staffView.commissions.some((c: any) => c.id === jobId)).toBe(true);
  });

  test("level cap: a Level 1 artist cannot quote $100 (cap $75)", async () => {
    const j2 = await buyer.call("createCommission", { creatorId: "test-atelier", buyerName: "Buyer", title: "Big piece", brief: "A very big commission brief.", budget: 100, kind: "standard", revisionsTotal: 2, payMethod: "crypto:btc" });
    const msg = await artist.callErr("milestoneAct", { id: j2.id, action: "quote", quotePrice: 100, depositAmount: 50 });
    expect(msg).toContain("level cap");
    expect(msg).toContain("$75");
  });

  test("quote $70 / $35 deposit", async () => {
    await artist.call("milestoneAct", { id: jobId, action: "quote", quotePrice: 70, depositAmount: 35 });
    const state = await buyer.call("getState", {});
    const job = state.commissions.find((c: any) => c.id === jobId);
    expect(job.status).toBe("quoted");
    expect(job.price).toBe(70);
    expect(job.depositAmount).toBe(35);
  });

  test("deposit txid: bad shape refused, good shape accepted, unrelated can't check", async () => {
    const bad = await buyer.callErr("milestoneAct", { id: jobId, action: "submitDepositTx", txid: "not-a-txid" });
    expect(bad).toContain("transaction ID");
    await buyer.call("milestoneAct", { id: jobId, action: "submitDepositTx", txid: TXID_1 });
    const nosy = await unrelated.callErr("milestoneAct", { id: jobId, action: "checkDepositTx" });
    expect(nosy).toBe("Only the buyer or artist of record can do that step.");
    await buyer.call("milestoneAct", { id: jobId, action: "checkDepositTx" });
    const state = await buyer.call("getState", {});
    const job = state.commissions.find((c: any) => c.id === jobId);
    expect(job.status).toBe("deposit_paid");
    expect(job.depositTxConfirmed).toBe(true);
    /* The simulated checker is honestly labelled in the job record. */
    const ledger = state.ledger.filter((l: any) => l.commissionId === jobId);
    expect(ledger.some((l: any) => l.note.includes("BETA HONESTY: this checker is simulated"))).toBe(true);
  });

  test("sketch → approval → vault delivery", async () => {
    const sketchRef = await artist.upload(new Blob([JPEG_BYTES], { type: "image/jpeg" }), "sketch");
    await artist.call("milestoneAct", { id: jobId, action: "submitSketch", sketchImageUrl: sketchRef });
    await buyer.call("milestoneAct", { id: jobId, action: "approveSketch" });
    const vaultRef = await artist.upload(new Blob([JPEG_BYTES], { type: "image/jpeg" }), "vault_original");
    vaultAssetId = vaultRef.slice("asset:".length);
    const previewRef = await artist.upload(new Blob([JPEG_BYTES], { type: "image/jpeg" }), "vault_preview");
    await artist.call("milestoneAct", { id: jobId, action: "deliverVault", vaultFileUrl: vaultRef, vaultPreviewUrl: previewRef, vaultFileName: "final-art.jpg" });
    const state = await buyer.call("getState", {});
    const job = state.commissions.find((c: any) => c.id === jobId);
    expect(job.status).toBe("vault_delivered");
    expect(job.hasVaultFile).toBe(true);
    /* The original is never exposed as a media URL. */
    const mediaTry = await buyer.raw("GET", `/media/${vaultAssetId}`);
    expect(mediaTry.status).toBe(404);
  });

  test("balance txid → simulated check → auto-unlock; golden standing totals", async () => {
    await buyer.call("milestoneAct", { id: jobId, action: "submitBalanceTx", txid: TXID_2 });
    await buyer.call("milestoneAct", { id: jobId, action: "checkBalanceTx" });
    const state = await buyer.call("getState", {});
    const job = state.commissions.find((c: any) => c.id === jobId);
    expect(job.status).toBe("unlocked");
    const buyerSession = await buyer.refreshSession();
    expect(buyerSession.account.credits).toBe(40);
    expect(buyerSession.account.lifetimeEarned).toBe(40);
    const artistSession = await artist.refreshSession();
    expect(artistSession.account.credits).toBe(85);
    expect(artistSession.account.lifetimeEarned).toBe(85);
  });

  test("buyer-only download, logged", async () => {
    const dl = await buyer.raw("GET", `/api/jobs/${jobId}/vault-file`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("x-download-count")).toBe("1");
    const dl2 = await buyer.raw("GET", `/api/jobs/${jobId}/vault-file`);
    expect(dl2.headers.get("x-download-count")).toBe("2");
    const byArtist = await artist.raw("GET", `/api/jobs/${jobId}/vault-file`);
    expect(byArtist.status).toBe(400);
    expect(byArtist.data.error.message).toBe("Only the buyer of record can download the unlocked original.");
    const byAnon = await anon.raw("GET", `/api/jobs/${jobId}/vault-file`);
    expect(byAnon.status).toBe(401);
    const rows = await srv.handle.db.select().from(schema.commissions).where(eq(schema.commissions.id, jobId));
    expect(rows[0]?.downloadCount).toBe(2);
  });

  test("legacy flow refuses v2 jobs; bidding is paused", async () => {
    const msg = await artist.callErr("actOnCommission", { id: jobId, action: "accept" });
    expect(msg).toBe("That job runs on the v2 milestone flow — milestone actions apply to it.");
    const bid = await anon.callErr("placeBid", { lotId: "lot_whatever", bidder: "Anon", amount: 10 });
    expect(bid).toContain("Bidding is paused on this build");
  });
});

describe("transport security", () => {
  test("POST without a CSRF token is 403 and the handler never runs", async () => {
    const c = new TestClient(srv.handler);
    await c.refreshSession();
    const r = await c.raw("POST", "/api/rpc/logIn", { body: { email: "buyer@example.com", password: PASSWORD }, csrf: null });
    expect(r.status).toBe(403);
    expect(r.data.error.code).toBe("csrf");
    const after = await c.refreshSession();
    expect(after.account).toBe(null);
  });

  test("POST with a foreign Origin is 403", async () => {
    const c = new TestClient(srv.handler);
    await c.refreshSession();
    const r = await c.raw("POST", "/api/rpc/logIn", { body: { email: "buyer@example.com", password: PASSWORD }, headers: { Origin: "http://evil.example" } });
    expect(r.status).toBe(403);
  });

  test("GET on an RPC route and unknown actions are 404", async () => {
    const g = await anon.raw("GET", "/api/rpc/getState");
    expect(g.status).toBe(404);
    const u = await anon.raw("POST", "/api/rpc/notARealAction", { body: {} });
    expect(u.status).toBe(404);
  });

  test("logout kills the session server-side", async () => {
    const c = new TestClient(srv.handler);
    await c.call("logIn", { email: "nosy@example.com", password: PASSWORD });
    const before = await c.refreshSession();
    expect(before.account?.username).toBe("nosy");
    await c.call("logOut", {});
    const after = await c.refreshSession();
    expect(after.account).toBe(null);
  });
});
