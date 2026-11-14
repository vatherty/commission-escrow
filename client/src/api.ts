// Typed RPC client for the standalone server (see ../../CONTRACT.md).
//
// Types come straight from the standalone server's action registry —
// `import type { Actions }` is type-only by design: the client bundle never
// pulls in any server runtime (pg, file APIs, etc.). With
// `verbatimModuleSyntax: true`, dropping `type` is a compile error.
//
// Transport: POST /api/rpc/<action> with a JSON body of the action args
// (any `token` key is stripped — there is no client-held session token).
// The real session is the server's HttpOnly cookie; every POST carries the
// CSRF token in the `X-CSRF-Token` header from the in-memory store below.
// Errors arrive as { ok: false, error: { code, message } } and are thrown
// as `new Error(message)` so the UI shows the server's exact text, exactly
// as it did when actions threw in the Space.

import type { z } from "zod";
import type { Actions } from "../../server/src/actions";

type Registry = typeof Actions;
type RequestOf<D> = D extends { request: infer R } ? z.infer<R> : never;
type ResponseOf<D> = D extends { response: infer R } ? z.infer<R> : never;

/* The account DTO, taken from the auth actions' response shape (the
   standalone registry has no getSession action — the session is a plain
   GET /api/session route, typed by SessionInfo below). */
type AccountOut = ResponseOf<Registry["signUp"]>["account"];

/** GET /api/session response: the signed-in account (or null) plus the
    CSRF token to echo on POSTs — the session-bound one when logged in,
    otherwise the anonymous double-submit token. */
export interface SessionInfo {
  account: AccountOut | null;
  csrfToken: string;
}

/** signUp/logIn, reshaped for the app: the server responds
    { csrfToken, account }; the app expects { token, account }, where
    `token` is that CSRF token. It is an in-memory header value only —
    NOT a session credential; the real session is the HttpOnly cookie. */
export interface AuthResult {
  token: string;
  account: AccountOut;
}

/* App.tsx still passes a `token` value around (in the standalone client it
   holds the CSRF token) and includes it in action args; the standalone
   request schemas no longer carry a token field — identity comes from the
   session cookie — and the transport strips the key before sending. The
   mapped type therefore accepts the legacy key at every call site.
   WithoutIndex drops index signatures first: an empty z.object({}) infers
   as Record<string, never>, whose `never` index would otherwise reject the
   token key outright. */
type WithoutIndex<T> = {
  [K in keyof T as K extends string ? (string extends K ? never : K) : K]: T[K];
};
type RpcApi = {
  [K in keyof Registry]: (args: WithoutIndex<RequestOf<Registry[K]>> & { token?: string }) => Promise<ResponseOf<Registry[K]>>;
};

export interface Api extends Omit<RpcApi, "signUp" | "logIn"> {
  getSession: (args?: { token?: string }) => Promise<SessionInfo>;
  signUp: (args: RequestOf<Registry["signUp"]>) => Promise<AuthResult>;
  logIn: (args: RequestOf<Registry["logIn"]>) => Promise<AuthResult>;
  uploadAsset: (blob: Blob, kind: string) => Promise<string>;
  downloadVaultFile: (commissionId: string) => Promise<{ downloadCount: number }>;
}

// Re-exported for convenience so client code can do
//
//     import { api, type ApiResponse } from "./api";
//     type Account = ApiResponse<typeof api, "getSession">["account"];
export type ApiRequest<C, K extends keyof C> = C[K] extends (args: infer A) => unknown ? A : never;
export type ApiResponse<C, K extends keyof C> = C[K] extends (...args: never[]) => Promise<infer R> ? R : never;

/* ---- CSRF token store: module-level, in memory only, never persisted ---- */
let csrfToken = "";
export function setCsrf(token: string): void {
  csrfToken = token ?? "";
}
export function getCsrf(): string {
  return csrfToken;
}

/* ---- Transport helpers ---- */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function parseJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function errorFrom(data: any, status: number): Error {
  const message = data?.error?.message;
  return new Error(typeof message === "string" && message ? message : `Request failed (${status})`);
}

async function fetchSession(): Promise<SessionInfo> {
  const res = await fetch("/api/session", { credentials: "same-origin" });
  const data = await parseJson(res);
  if (!res.ok || (data && data.ok === false)) throw errorFrom(data, res.status);
  const csrf = typeof data?.csrfToken === "string" ? data.csrfToken : "";
  setCsrf(csrf);
  return { account: (data?.account ?? null) as AccountOut | null, csrfToken: csrf };
}

/* Before the first POST there may be no CSRF token yet (page load fires
   RPC reads immediately). Bootstrap one from GET /api/session — it always
   returns a token (anonymous double-submit when signed out) and sets the
   matching cookie. Concurrent callers share one bootstrap fetch. */
let csrfBootstrap: Promise<void> | null = null;
function ensureCsrf(): Promise<void> {
  if (csrfToken) return Promise.resolve();
  if (!csrfBootstrap) {
    csrfBootstrap = (async () => {
      try {
        await fetchSession();
      } catch {
        /* Leave the store empty; the POST below surfaces the real error. */
      } finally {
        csrfBootstrap = null;
      }
    })();
  }
  return csrfBootstrap;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function postJson(path: string, body: unknown): Promise<any> {
  await ensureCsrf();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  const data = await parseJson(res);
  if (!res.ok || (data && data.ok === false)) throw errorFrom(data, res.status);
  return data;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rpc(name: string, args: Record<string, unknown> | undefined): Promise<any> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (key !== "token") body[key] = value;
  }
  return postJson(`/api/rpc/${name}`, body);
}

async function auth(name: "signUp" | "logIn", args: Record<string, unknown>): Promise<AuthResult> {
  const data = await rpc(name, args);
  const csrf = typeof data?.csrfToken === "string" ? data.csrfToken : "";
  setCsrf(csrf);
  return { token: csrf, account: data?.account as AccountOut };
}

/* ---- Media (CONTRACT step 6) ---- */

/** Upload flow: init → PUT the raw bytes → complete. Returns the stored
    asset reference (`asset:<id>`); server DTOs turn it into a /media/<id>
    URL in responses. */
export async function uploadAsset(blob: Blob, kind: string): Promise<string> {
  const mimeType = blob.type || "application/octet-stream";
  const init = await postJson("/api/uploads/init", { kind, mimeType, byteSize: blob.size });
  const assetId = init?.assetId;
  const uploadPath = init?.uploadPath;
  if (typeof assetId !== "string" || typeof uploadPath !== "string") {
    throw new Error("That upload could not be started — please try again.");
  }
  const putHeaders: Record<string, string> = { "Content-Type": mimeType };
  if (csrfToken) putHeaders["X-CSRF-Token"] = csrfToken;
  const putRes = await fetch(uploadPath, {
    method: "PUT",
    credentials: "same-origin",
    headers: putHeaders,
    body: blob,
  });
  if (!putRes.ok) {
    const data = await parseJson(putRes);
    throw errorFrom(data, putRes.status);
  }
  const done = await postJson("/api/uploads/complete", { assetId });
  if (typeof done?.ref !== "string") {
    throw new Error("That upload did not finish — please try again.");
  }
  return done.ref as string;
}

function downloadFilename(header: string | null): string {
  if (header) {
    const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (star?.[1]) {
      try {
        return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
      } catch {
        /* fall through to the plain filename form */
      }
    }
    const plain = /filename="?([^";]+)"?/i.exec(header);
    if (plain?.[1]) return plain[1].trim();
  }
  return "final-artwork";
}

/** Vault download: the endpoint re-checks unlock + buyer-of-record, logs
    the download server-side, and streams the original as an attachment.
    This turns the response into a browser download and reports the
    server's download count from the X-Download-Count header. */
export async function downloadVaultFile(commissionId: string): Promise<{ downloadCount: number }> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(commissionId)}/vault-file`, {
    credentials: "same-origin",
  });
  if (!res.ok) {
    const data = await parseJson(res);
    throw errorFrom(data, res.status);
  }
  const countHeader = res.headers.get("X-Download-Count");
  const parsed = countHeader ? Number.parseInt(countHeader, 10) : Number.NaN;
  const downloadCount = Number.isNaN(parsed) ? 0 : parsed;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = downloadFilename(res.headers.get("Content-Disposition"));
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { downloadCount };
}

/* ---- The client object: named members for the non-RPC routes, a proxy
   fallback that turns any other registry action name into an RPC call ---- */
const base: Record<string, unknown> = {
  getSession: (_args?: { token?: string }) => fetchSession(),
  signUp: (args: Record<string, unknown>) => auth("signUp", args),
  logIn: (args: Record<string, unknown>) => auth("logIn", args),
  logOut: async (args?: Record<string, unknown>) => {
    const data = await rpc("logOut", args);
    setCsrf("");
    return data;
  },
  uploadAsset,
  downloadVaultFile,
};

export const api: Api = new Proxy(base, {
  get(target, prop, receiver) {
    if (typeof prop === "string" && !(prop in target)) {
      return (args?: Record<string, unknown>) => rpc(prop, args);
    }
    return Reflect.get(target, prop, receiver);
  },
}) as unknown as Api;
