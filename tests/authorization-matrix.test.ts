import { beforeAll, describe, expect, test } from "bun:test";
import * as schema from "../server/src/schema";
import { ensureLaunchInvites } from "../server/src/seed-content";
import { OWNER_EMAIL, PASSWORD, TestClient, makeServer, type TestServer } from "./helpers";

/* The golden authorization matrix (plan §9.4): for each protected
   surface, anonymous / unrelated member / wrong party / right party /
   mod / dev get exactly the answers the Space build gave. "Not found"
   answers are deliberate: a page you don't own is indistinguishable
   from a page that doesn't exist. */

let srv: TestServer;
let codes: string[] = [];
let anon: TestClient, owner: TestClient, artist: TestClient, buyer: TestClient, unrelated: TestClient;
let jobId = "", demoJobId = "", postId = "";
const LOGIN = "Please log in first — your session may have expired.";
const NOT_FOUND = "That page couldn't be found.";

beforeAll(async () => {
  srv = await makeServer();
  codes = (await ensureLaunchInvites(srv.handle.db)).codes;
  anon = new TestClient(srv.handler);
  owner = new TestClient(srv.handler);
  artist = new TestClient(srv.handler);
  buyer = new TestClient(srv.handler);
  unrelated = new TestClient(srv.handler);
  await owner.call("signUp", { displayName: "Owner", username: "owner", email: OWNER_EMAIL, password: PASSWORD, accountType: "buyer", over18: true, inviteCode: "", fingerprint: "" });
  await artist.call("signUp", { displayName: "Artist", username: "artist", email: "artist@example.com", password: PASSWORD, accountType: "creator", shopName: "Matrix Shop", over18: true, inviteCode: codes[0], fingerprint: "" });
  await buyer.call("signUp", { displayName: "Buyer", username: "buyer", email: "buyer@example.com", password: PASSWORD, accountType: "buyer", over18: true, inviteCode: codes[1], fingerprint: "" });
  await unrelated.call("signUp", { displayName: "Nosy", username: "nosy", email: "nosy@example.com", password: PASSWORD, accountType: "buyer", over18: true, inviteCode: codes[2], fingerprint: "" });
  const j = await buyer.call("createCommission", { creatorId: "matrix-shop", buyerName: "Buyer", title: "Matrix job", brief: "A job for the authorization matrix.", budget: 60, kind: "standard", revisionsTotal: 2, payMethod: "external" });
  jobId = j.id;
  const post = await artist.call("createPost", { title: "Matrix offer", body: "An offer post for the matrix.", priceNote: "", imageUrl: "", videoUrl: "", categories: [] });
  postId = post.id;
  /* A seeded-style demo job: v2, no buyer account, unowned demo shop. */
  const db = srv.handle.db;
  await db.insert(schema.creators).values({ id: "demo-shop", name: "Demo Shop", handle: "@demo", tagline: "", accent: "#888888", bio: "", status: "open", turnaround: "", pricesJson: "[]", willDoJson: "[]", wontDoJson: "[]", portfolioJson: "[]" });
  demoJobId = "comm_demo_matrix";
  await db.insert(schema.commissions).values({ id: demoJobId, creatorId: "demo-shop", buyerName: "Demo Buyer", title: "Demo job", brief: "Demo", refsText: "", budget: 50, price: 50, kind: "standard", rail: "reserve", status: "quoted", v2: 1, payMethod: "crypto:btc", depositAmount: 25, depositTx: "c".repeat(64) });
});

describe("milestoneAct party checks (real-account job)", () => {
  test("anonymous → login message; unrelated → artist-only message; buyer → artist-only message", async () => {
    expect(await anon.callErr("milestoneAct", { id: jobId, action: "quote", quotePrice: 60 })).toBe(LOGIN);
    expect(await unrelated.callErr("milestoneAct", { id: jobId, action: "quote", quotePrice: 60 })).toBe("Only the job's artist can do that step.");
    expect(await buyer.callErr("milestoneAct", { id: jobId, action: "quote", quotePrice: 60 })).toBe("Only the job's artist can do that step.");
    const ok = await artist.call("milestoneAct", { id: jobId, action: "quote", quotePrice: 60, depositAmount: 30 });
    expect(ok.ok).toBe(true);
  });

  test("buyer-side step attempted by the artist → buyer-only message", async () => {
    const msg = await artist.callErr("milestoneAct", { id: jobId, action: "walkAway" });
    /* walkAway checks the deadline first in the original ordering of
       party(): party runs before the deadline check, so the party
       message is the answer. */
    expect(msg).toBe("Only the buyer of record can do that step.");
  });
});

describe("demo jobs: open side is staff-only (plan §4.1.5)", () => {
  test("milestoneAct on a demo job: anon → login, member → not found, staff → works", async () => {
    expect(await anon.callErr("milestoneAct", { id: demoJobId, action: "checkDepositTx" })).toBe(LOGIN);
    expect(await unrelated.callErr("milestoneAct", { id: demoJobId, action: "checkDepositTx" })).toBe(NOT_FOUND);
    const ok = await owner.call("milestoneAct", { id: demoJobId, action: "checkDepositTx" });
    expect(ok.ok).toBe(true);
  });

  test("legacy actOnCommission on a demo job: member → not found, staff → works", async () => {
    /* Give the demo job a legacy (v1) shape for the legacy flow. */
    const db = srv.handle.db;
    const { eq } = await import("drizzle-orm");
    await db.update(schema.commissions).set({ v2: 0, buyerAccountId: null }).where(eq(schema.commissions.id, demoJobId));
    expect(await unrelated.callErr("actOnCommission", { id: demoJobId, action: "accept" })).toBe(NOT_FOUND);
    const ok = await owner.call("actOnCommission", { id: demoJobId, action: "accept" });
    expect(ok.ok).toBe(true);
  });

  test("demo jobs stay publicly readable in getState (display-only)", async () => {
    const state = await anon.call("getState", {});
    expect(state.commissions.some((c: any) => c.id === demoJobId)).toBe(true);
    /* …while the real-account job stays invisible to the public. */
    expect(state.commissions.some((c: any) => c.id === jobId)).toBe(false);
  });
});

describe("ownership-scoped surfaces", () => {
  test("theme edit on someone else's page → not found", async () => {
    const msg = await buyer.callErr("updateCreatorTheme", { creatorId: "matrix-shop", pfpUrl: "", bannerUrl: "", bgColor: "#fffef9", panelColor: "#ffffff", accent: "#e05260", accent2: "#facc15", headingColor: "#334155", bodyColor: "#475569", bgImageUrl: "", showcaseUrl: "", portfolioImages: {}, categories: [], paymentMethods: [], cryptoWallets: [], verifiedOnly: false });
    expect(msg).toBe(NOT_FOUND);
  });

  test("buyers can't post offers; strangers can't delete posts", async () => {
    expect(await buyer.callErr("createPost", { title: "Nope", body: "Buyer post attempt.", priceNote: "", imageUrl: "", videoUrl: "", categories: [] })).toBe("Only creator accounts can post offers — this account doesn't have a creator page.");
    expect(await unrelated.callErr("deletePost", { postId })).toBe("That post couldn't be found.");
    expect(await buyer.callErr("deletePost", { postId })).toBe("That post couldn't be found.");
    const ok = await artist.call("deletePost", { postId });
    expect(ok.ok).toBe(true);
  });

  test("adminGetState: anon → login, member → not found, dev → full bundle", async () => {
    expect(await anon.callErr("adminGetState", {})).toBe(LOGIN);
    expect(await unrelated.callErr("adminGetState", {})).toBe(NOT_FOUND);
    const admin = await owner.call("adminGetState", {});
    expect(admin.invites.length).toBe(10);
    expect(admin.accounts.length).toBe(4);
  });

  test("anonymous commission creation is refused (login required)", async () => {
    const msg = await anon.callErr("createCommission", { creatorId: "matrix-shop", buyerName: "Ghost", title: "Anon job", brief: "Trying to create anonymously.", budget: 50, kind: "standard", revisionsTotal: 2, payMethod: "external" });
    expect(msg).toBe(LOGIN);
  });
});
