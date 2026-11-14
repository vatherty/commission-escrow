import type { z } from "zod";
import type { Db } from "./db";
import type { AccountRow } from "./auth";

/* Local action registry — the standalone replacement for the artifact's
   defineAction/ActionsModule (port plan §4, coupling #1). The registry is
   the internal contract: the router exposes ONLY the actions registered
   here (allowlist; unknown action = 404), validates input and output with
   each action's Zod schemas, and runs every handler inside a transaction. */

export interface AppCtx {
  db: Db;
  account: AccountRow | null;
  /** sha256 hash of the presented session token, when logged in. */
  sessionHash: string | null;
  /** Set by auth handlers (via startSession) for the router to emit. */
  setSessionCookie: string | null;
  clearSessionCookie: boolean;
  /** Raw CSRF token minted with the current session (auth responses). */
  csrfToken: string | null;
  requestId: string;
  ip: string | null;
}

export interface ActionDef<Req, Res> {
  description?: string;
  request: z.ZodType<Req>;
  response: z.ZodType<Res>;
  handler: (ctx: AppCtx, args: Req) => Promise<Res>;
}

export function defineAction<Req, Res>(def: ActionDef<Req, Res>): ActionDef<Req, Res> {
  return def;
}

export type ActionsModule = Record<string, ActionDef<never, never>>;
