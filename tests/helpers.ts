import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type DbHandle } from "../server/src/db";
import { localStorageAt } from "../server/src/storage";
import { createHandler } from "../server/src/router";

/* Shared test harness: a fresh in-memory PGlite database + the real HTTP
   handler driven with Request objects (no sockets). TestClient tracks
   cookies and the in-memory CSRF token exactly like the real client. */

process.env.OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.com";
export const OWNER_EMAIL = process.env.OWNER_EMAIL;

export interface TestServer {
  handle: DbHandle;
  handler: (req: Request) => Promise<Response>;
  storageDir: string;
}

export async function makeServer(): Promise<TestServer> {
  const handle = await createTestDb();
  const storageDir = mkdtempSync(join(tmpdir(), "ce-test-storage-"));
  const handler = createHandler({
    handle,
    storage: localStorageAt(storageDir),
    clientDir: mkdtempSync(join(tmpdir(), "ce-test-client-")),
  });
  return { handle, handler, storageDir };
}

export class TestClient {
  cookies = new Map<string, string>();
  csrf = "";
  constructor(private handler: (req: Request) => Promise<Response>) {}

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  private absorb(res: Response): void {
    const set = res.headers.get("set-cookie");
    if (!set) return;
    for (const part of set.split(/,(?=[^,;]+=)/)) {
      const first = part.split(";")[0] ?? "";
      const idx = first.indexOf("=");
      if (idx > 0) {
        const name = first.slice(0, idx).trim();
        const value = first.slice(idx + 1).trim();
        if (value === "") this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
    }
  }

  async raw(method: string, path: string, init: { body?: unknown; headers?: Record<string, string>; csrf?: string | null; rawBody?: BodyInit } = {}): Promise<{ status: number; data: any; headers: Headers }> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    const cookie = this.cookieHeader();
    if (cookie) headers["Cookie"] = cookie;
    if (init.csrf !== null && method !== "GET") {
      const token = init.csrf ?? this.csrf;
      if (token) headers["X-CSRF-Token"] = token;
    }
    let body: BodyInit | undefined = init.rawBody;
    if (body === undefined && init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const res = await this.handler(new Request(`http://test.local${path}`, { method, headers, body }));
    this.absorb(res);
    let data: any = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }

  async refreshSession(): Promise<any> {
    const r = await this.raw("GET", "/api/session");
    if (r.data?.csrfToken) this.csrf = r.data.csrfToken;
    return r.data;
  }

  /** RPC call that throws Error(message) on failure, like the real client. */
  async call<T = any>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.csrf) await this.refreshSession();
    const r = await this.raw("POST", `/api/rpc/${action}`, { body: args });
    if (r.status !== 200 || (r.data && r.data.ok === false)) {
      throw new Error(r.data?.error?.message ?? `RPC ${action} failed (${r.status})`);
    }
    if (action === "signUp" || action === "logIn") {
      if (r.data?.csrfToken) this.csrf = r.data.csrfToken;
    }
    if (action === "logOut") this.csrf = "";
    return r.data as T;
  }

  /** RPC call that returns the failure message instead of throwing. */
  async callErr(action: string, args: Record<string, unknown> = {}): Promise<string> {
    try {
      await this.call(action, args);
      return "";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  async upload(blob: Blob, kind: string): Promise<string> {
    if (!this.csrf) await this.refreshSession();
    const init = await this.raw("POST", "/api/uploads/init", { body: { kind, mimeType: blob.type || "application/octet-stream", byteSize: blob.size } });
    if (init.status !== 200) throw new Error(init.data?.error?.message ?? "upload init failed");
    const put = await this.raw("PUT", init.data.uploadPath, { rawBody: blob, headers: { "Content-Type": blob.type || "application/octet-stream" } });
    if (put.status !== 200) throw new Error(put.data?.error?.message ?? "upload blob failed");
    const done = await this.raw("POST", "/api/uploads/complete", { body: { assetId: init.data.assetId } });
    if (done.status !== 200) throw new Error(done.data?.error?.message ?? "upload complete failed");
    return done.data.ref as string;
  }
}

/** Minimal byte strings with real magic headers for the sniffer. */
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 1, 2, 3, 4, 5, 6, 7, 8]);
export const MP4_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4]);

export const PASSWORD = "a long test passphrase 42";
export const BTC_ADDRESS = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
export const TXID_1 = "a".repeat(64);
export const TXID_2 = "b".repeat(64);
