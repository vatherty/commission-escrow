import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";

/* Object storage behind one small interface (port plan §3.6). The bucket is
   PRIVATE in every driver: bytes are only ever served by the app server
   after its per-request authorization/quarantine checks — a raw storage
   URL is never handed to a client.
   - STORAGE_DRIVER=local → files under STORAGE_DIR (default ./storage-data).
     Used for local dev/tests; the exact same code paths run.
   - STORAGE_DRIVER=s3    → any S3-compatible bucket (Cloudflare R2
     recommended) via Bun's native S3 client. */

export interface StorageDriver {
  put(key: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

function safeKey(key: string): string {
  const k = normalize(key).replace(/^(\.\.[/\\])+/, "");
  if (k.includes("..")) throw new Error("Invalid storage key");
  return k;
}

class LocalDriver implements StorageDriver {
  constructor(private root: string) {}
  private path(key: string) { return join(this.root, safeKey(key)); }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }
  async get(key: string): Promise<Uint8Array | null> {
    try { return new Uint8Array(await readFile(this.path(key))); } catch { return null; }
  }
  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
  async exists(key: string): Promise<boolean> {
    try { await readFile(this.path(key)); return true; } catch { return false; }
  }
}

interface BunS3ClientLike {
  write(key: string, data: Uint8Array, opts?: { type?: string }): Promise<number>;
  file(key: string): { exists(): Promise<boolean>; arrayBuffer(): Promise<ArrayBuffer>; delete(): Promise<void> };
}
type BunGlobal = { S3Client?: new (opts: Record<string, string | undefined>) => BunS3ClientLike };

class S3Driver implements StorageDriver {
  private client: BunS3ClientLike;
  constructor() {
    const BunCtor = (globalThis as { Bun?: BunGlobal }).Bun?.S3Client;
    if (!BunCtor) throw new Error("S3 storage driver requires the Bun runtime (Bun.S3Client)");
    this.client = new BunCtor({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? "auto",
      bucket: process.env.S3_BUCKET,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    });
  }
  async put(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    await this.client.write(safeKey(key), bytes, { type: mimeType });
  }
  async get(key: string): Promise<Uint8Array | null> {
    const f = this.client.file(safeKey(key));
    if (!(await f.exists())) return null;
    return new Uint8Array(await f.arrayBuffer());
  }
  async delete(key: string): Promise<void> { await this.client.file(safeKey(key)).delete(); }
  async exists(key: string): Promise<boolean> { return this.client.file(safeKey(key)).exists(); }
}

let cached: StorageDriver | null = null;
export function getStorage(): StorageDriver {
  if (cached) return cached;
  const driver = (process.env.STORAGE_DRIVER ?? "local").toLowerCase();
  cached = driver === "s3" ? new S3Driver() : new LocalDriver(process.env.STORAGE_DIR ?? "./storage-data");
  return cached;
}

/** Test helper: an isolated local driver rooted at a temp dir. */
export function localStorageAt(dir: string): StorageDriver {
  return new LocalDriver(dir);
}
