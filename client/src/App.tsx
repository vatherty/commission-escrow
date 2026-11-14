import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, uploadAsset, type ApiResponse } from "./api";

type State = ApiResponse<typeof api, "getState">;
type Creator = State["creators"][number];
type Comm = State["commissions"][number];
type Account = ApiResponse<typeof api, "getSession">["account"];
type Post = ApiResponse<typeof api, "listPosts">["posts"][number];
function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return "just now";
  const m = Math.floor(ms / 60000); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
/* Creator accents are free-choice colours — a near-white accent must never
   make feed text invisible. These pick a readable foreground for/on it. */
function accentLuminance(hex: string): number {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m || !m[1]) return 0;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}
function onAccent(hex: string): string { return accentLuminance(hex) > 0.65 ? "#334155" : "#ffffff"; }
function accentAsText(hex: string): string { return accentLuminance(hex) > 0.65 ? "#64748b" : hex; }
function slugify(s: string): string { return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function creatorSlug(c: Creator): string { return slugify(c.name) || c.id; }

const money = (n: number) => `$${n.toLocaleString()}`;
const STATUS_LABEL: Record<string, string> = { requested: "Requested", accepted: "Accepted", countered: "Countered", declined: "Declined", reserved: "Reserved — pre-auth held", funded: "Funded — in vault", in_progress: "In Progress", sketch_review: "Sketch Approval", delivered: "Delivered", released: "Released", refunded: "Refunded", disputed: "Disputed", brief: "Brief", quoted: "Quoted", deposit_paid: "Deposit Paid — Working", sketch_approved: "Sketch Approved", vault_delivered: "Delivered to Vault", unlocked: "Unlocked — Complete", walked_away: "Walked Away", cancelled: "Cancelled" };
const V2_STEPS = ["Brief", "Quoted", "Deposit Paid", "Sketch Approved", "Delivered to Vault", "Balance Paid", "Unlocked"];
function v2StepIndex(c: Comm): number {
  switch (c.status) { case "brief": return 0; case "quoted": return 1; case "deposit_paid": case "sketch_review": return 2; case "sketch_approved": return 3; case "vault_delivered": return 4; case "unlocked": return 6; default: return 0; }
}
/* Best-effort device fingerprint for the ban-evasion TRIPWIRE: a hash of a
   canvas render + screen + user-agent composite, computed locally. It is
   never used to block anyone — a match only flags the account for the
   owner in Admin (fingerprints are spoofable and devices get shared). */
function deviceFingerprint(): string {
  try {
    const cv = document.createElement("canvas"); cv.width = 220; cv.height = 40;
    const g = cv.getContext("2d");
    let canvasPart = "";
    if (g) { g.fillStyle = "#f472b6"; g.fillRect(0, 0, 220, 40); g.fillStyle = "#334155"; g.font = "16px Nunito, sans-serif"; g.fillText("commission-escrow ♥", 8, 24); canvasPart = cv.toDataURL(); }
    const raw = [canvasPart, navigator.userAgent, `${screen.width}x${screen.height}x${screen.colorDepth}`, Intl.DateTimeFormat().resolvedOptions().timeZone ?? "", navigator.language].join("|");
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < raw.length; i++) { const ch = raw.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
  } catch { return ""; }
}
/** Watermarked, downscaled preview for a vault image: drawn on canvas at
    max 640px with a repeating diagonal watermark — this preview (never
    the original) is what the buyer sees before unlock. */
function makeWatermarkedPreview(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 640 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
      const g = canvas.getContext("2d");
      if (!g) { reject(new Error("Canvas unavailable")); return; }
      g.drawImage(img, 0, 0, w, h);
      g.save();
      g.translate(w / 2, h / 2); g.rotate(-Math.PI / 7);
      g.font = `bold ${Math.max(14, Math.round(w / 16))}px Nunito, sans-serif`;
      g.fillStyle = "rgba(255,255,255,0.55)"; g.textAlign = "center";
      const step = Math.max(90, Math.round(h / 4));
      for (let y = -h; y < h; y += step) g.fillText("Commission Escrow • PREVIEW", 0, y);
      g.restore();
      canvas.toBlob(b => { if (!b) { reject(new Error("Canvas unavailable")); return; } uploadAsset(b, "vault_preview").then(resolve, reject); }, "image/jpeg", 0.72);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file could not be read as an image.")); };
    img.src = url;
  });
}
/** Poster-frame preview for a vault MP4: captures one frame, watermarks
    it the same way — the video original itself stays server-side only. */
function makeVideoPreview(file: File): Promise<string> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.src = url; v.preload = "auto";
    const done = (out: string) => { URL.revokeObjectURL(url); resolve(out); };
    v.onerror = () => done("");
    v.onloadeddata = () => { try { v.currentTime = Math.min(0.6, (v.duration || 1) / 2); } catch { done(""); } };
    v.onseeked = () => {
      try {
        const scale = Math.min(1, 640 / Math.max(v.videoWidth || 640, v.videoHeight || 360));
        const w = Math.max(1, Math.round((v.videoWidth || 640) * scale));
        const h = Math.max(1, Math.round((v.videoHeight || 360) * scale));
        const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
        const g = canvas.getContext("2d");
        if (!g) { done(""); return; }
        g.drawImage(v, 0, 0, w, h);
        g.save(); g.translate(w / 2, h / 2); g.rotate(-Math.PI / 7);
        g.font = `bold ${Math.max(14, Math.round(w / 16))}px Nunito, sans-serif`;
        g.fillStyle = "rgba(255,255,255,0.55)"; g.textAlign = "center";
        g.fillText("Commission Escrow • PREVIEW", 0, 0);
        g.restore();
        canvas.toBlob(b => { if (!b) { done(""); return; } uploadAsset(b, "vault_preview").then(ref => done(ref), () => done("")); }, "image/jpeg", 0.72);
      } catch { done(""); }
    };
    setTimeout(() => done(""), 4000);
  });
}
const STEPS = ["Requested", "Accepted", "Reserved / Funded", "In Progress", "Sketch Approval", "Delivered", "Released"];
function stepIndex(c: Comm): number {
  switch (c.status) { case "requested": case "countered": return 0; case "accepted": return 1; case "reserved": case "funded": return 2; case "in_progress": return 3; case "sketch_review": return 4; case "delivered": return 5; case "released": return 6; default: return 0; }
}
function daysLeft(deadline: string | null): string { if (!deadline) return "Clock starts when funded"; const ms = new Date(deadline).getTime() - Date.now(); if (ms < 0) return "Overdue — refund due"; const d = Math.floor(ms / 86400000); const h = Math.floor((ms % 86400000) / 3600000); return `${d}d ${h}h left`; }

/* ---- URL routing (hash-based, so every page has its own shareable URL that
   survives refresh inside the artifact frame, and Back/Forward just work) ----
   #/ Home · #/search Search + creator directory (old #/creators redirects
   here) · #/creators/<slug> a creator's own page · #/jobs Inbox & Jobs ·
   #/vault Weekly Vault · #/account My Profile hub · #/how-it-works explainer.
   Navigation is a fixed bottom tab bar (Home / Search / Weekly Vault /
   My Profile) — see the shell at the bottom of App. */
type SearchSort = "relevance" | "name" | "newest";
type Route = { name: "home" } | { name: "creator"; slug: string } | { name: "jobs" } | { name: "vault" } | { name: "how" } | { name: "terms" } | { name: "login" } | { name: "signup" } | { name: "account" } | { name: "admin" } | { name: "search"; text: string; cats: string[]; mode: "any" | "all"; sort: SearchSort } | { name: "notfound"; path: string };
function searchPath(text: string, cats: string[], mode: "any" | "all", sort: SearchSort): string {
  const p = new URLSearchParams();
  if (text.trim()) p.set("q", text.trim());
  cats.forEach(c => p.append("cat", c));
  if (mode === "all") p.set("mode", "all");
  if (sort !== "relevance") p.set("sort", sort);
  const qs = p.toString();
  return qs ? `/search?${qs}` : "/search";
}
function parseHash(): Route {
  const raw = window.location.hash.replace(/^#/, "");
  const qIdx = raw.indexOf("?");
  const pathPart = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  const query = new URLSearchParams(qIdx >= 0 ? raw.slice(qIdx + 1) : "");
  const path = pathPart === "" ? "/" : pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  const seg = path.split("/").filter(Boolean);
  if (seg.length === 0) return { name: "home" };
  if (seg.length === 1) {
    const s = seg[0];
    /* The old Creators directory merged into Search — #/creators parses as
       the default Search view, and normalizeLegacyHash rewrites the URL. */
    if (s === "creators") return { name: "search", text: "", cats: [], mode: "any", sort: "relevance" };
    if (s === "jobs") return { name: "jobs" };
    if (s === "vault") return { name: "vault" };
    if (s === "how-it-works") return { name: "how" };
    if (s === "terms") return { name: "terms" };
    if (s === "login") return { name: "login" };
    if (s === "signup") return { name: "signup" };
    if (s === "account") return { name: "account" };
    if (s === "admin") return { name: "admin" };
    if (s === "search") { const sortRaw = query.get("sort"); return { name: "search", text: query.get("q") ?? "", cats: query.getAll("cat"), mode: query.get("mode") === "all" ? "all" : "any", sort: sortRaw === "name" || sortRaw === "newest" ? sortRaw : "relevance" }; }
    return { name: "notfound", path };
  }
  const slug = seg[1];
  if (seg.length === 2 && seg[0] === "creators" && slug) return { name: "creator", slug };
  return { name: "notfound", path };
}
/* The old #/creators directory URL redirects to #/search (Search absorbed
   the directory). Rewritten in place — no extra history entry — so old
   bookmarks and shared links land on the consolidated tab. */
function normalizeLegacyHash() {
  const raw = window.location.hash.replace(/^#/, "");
  const path = raw.split("?")[0] || "/";
  if (path === "/creators") window.history.replaceState(null, "", "#/search");
}
function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => { normalizeLegacyHash(); return parseHash(); });
  useEffect(() => {
    const on = () => { normalizeLegacyHash(); setRoute(parseHash()); window.scrollTo({ top: 0 }); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
function navigate(path: string) {
  const target = `#${path}`;
  if (window.location.hash === target) window.scrollTo({ top: 0 });
  else window.location.hash = target;
}

function Icon({ name, className = "w-5 h-5" }: { name: string; className?: string }) {
  const paths: Record<string, string> = {
    star: "M12 2l2.6 6.2 6.7.5-5.1 4.4 1.6 6.5L12 16.2 6.2 19.6l1.6-6.5L2.7 8.7l6.7-.5L12 2z",
    heart: "M12 21s-7.5-4.6-9.8-9C.6 8.9 2.3 5 5.7 5c2 0 3.4 1.1 4.3 2.4h4C15 6.1 16.4 5 18.4 5c3.4 0 5.1 3.9 3.5 7-2.3 4.4-9.9 9-9.9 9z",
    spark: "M12 2l1.8 7.2L21 11l-7.2 1.8L12 20l-1.8-7.2L3 11l7.2-1.8L12 2z",
    coin: "M12 2a10 10 0 100 20 10 10 0 000-20zm0 5v10M15 8.5c-.6-1-1.6-1.5-3-1.5-1.7 0-3 .9-3 2.2 0 3 6 1.6 6 4.6 0 1.3-1.3 2.2-3 2.2-1.4 0-2.5-.6-3.1-1.6",
    shield: "M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5l8-3z",
    brush: "M18 2l4 4-9.5 9.5a3.5 3.5 0 01-5 0L5 13l2.5-2.5L18 2zM5 15c-1 2-2 5-2 5s3-1 5-2",
    gift: "M4 10h16v10H4zM12 10v10M4 6h16v4H4zM12 6c-4 0-5-4-2.5-4C12 2 12 6 12 6zm0 0c4 0 5-4 2.5-4C12 2 12 6 12 6z",
    home: "M4 11.5L12 4l8 7.5M6.5 10v9.5h11V10M10 19.5v-5h4v5",
    search: "M10.5 3.5a7 7 0 1 0 0 14 7 7 0 1 0 0-14M15.5 15.5L21 21",
    user: "M12 3a4 4 0 1 0 0 8 4 4 0 1 0 0-8M5 20.5c1.4-3.6 4-5.2 7-5.2s5.6 1.6 7 5.2",
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"><path d={paths[name] ?? paths.star} /></svg>;
}
function Starburst({ children, color = "#fde047", className = "" }: { children: React.ReactNode; color?: string; className?: string }) {
  return <span className={`starburst inline-flex items-center justify-center text-center font-semibold text-slate-700 ${className}`} style={{ background: color, width: 64, height: 64, fontSize: 11, lineHeight: 1.1, padding: 10 }}>{children}</span>;
}
function Wavy({ color = "#fda4af" }: { color?: string }) {
  return <svg viewBox="0 0 1200 18" className="w-full h-[14px] block" preserveAspectRatio="none" aria-hidden="true"><path d="M0 9 Q 25 0 50 9 T 100 9 T 150 9 T 200 9 T 250 9 T 300 9 T 350 9 T 400 9 T 450 9 T 500 9 T 550 9 T 600 9 T 650 9 T 700 9 T 750 9 T 800 9 T 850 9 T 900 9 T 950 9 T 1000 9 T 1050 9 T 1100 9 T 1150 9 T 1200 9" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" /></svg>;
}
function Speech({ children, color = "#fef9c3" }: { children: React.ReactNode; color?: string }) {
  return <div className="bubble speech inline-block px-4 py-2.5 text-sm font-semibold text-slate-600 border border-slate-200 mb-3" style={{ background: color }}>{children}</div>;
}
function isVideoMedia(v?: string): boolean { return !!v && (v.startsWith("data:video/") || /\.mp4($|\?)/i.test(v)); }
/* Standalone media values are /media/<id> URLs with no file extension, so a
   portfolio tile can only tell video from image via the item's own kind
   text (e.g. "Video preview") — ArtTile receives that kind as a prop. */
function kindSaysVideo(kind: string): boolean { return /video/i.test(kind); }
function ArtTile({ hue, title, kind, watermark, image }: { hue: number; title: string; kind: string; watermark?: boolean; image?: string }) {
  const [imgOk, setImgOk] = useState(true);
  useEffect(() => { setImgOk(true); }, [image]);
  const video = isVideoMedia(image) || (!!image && kindSaysVideo(kind));
  const patterns = [
    `radial-gradient(circle at 8px 8px, rgba(255,255,255,.85) 3px, transparent 4px)`,
    `repeating-conic-gradient(rgba(255,255,255,.35) 0% 25%, transparent 0% 50%)`,
    `radial-gradient(circle, rgba(255,255,255,.7) 4px, transparent 5px)`,
  ];
  const pat = patterns[Math.abs(hue) % patterns.length];
  const glyphs = ["★", "♥", "✿", "●"];
  const glyph = glyphs[Math.abs(hue) % glyphs.length];
  return (
    <div className="relative overflow-hidden aspect-[4/3] border border-slate-200" style={{ background: `hsl(${hue} 80% 82%)` }} aria-label={`Artwork: ${title}`}>
      {video && image ? <video src={image} controls preload="metadata" playsInline className="absolute inset-0 w-full h-full object-cover bg-black" aria-label={`Video: ${title}`} />
      : image && imgOk ? <img src={image} alt={`Artwork: ${title}`} className="absolute inset-0 w-full h-full object-cover" onError={() => setImgOk(false)} /> : <><div className="absolute inset-0" style={{ backgroundImage: pat, backgroundSize: hue % 3 === 1 ? "22px 22px" : "26px 26px" }} />
      <div className="absolute inset-0 flex items-center justify-center"><span className="text-5xl drop-shadow-sm" style={{ color: `hsl(${hue} 75% 55%)` }}>{glyph}</span><span className="absolute top-2 left-2 text-lg" style={{ color: `hsl(${hue} 75% 60%)` }}>✦</span><span className="absolute bottom-8 right-2 text-lg" style={{ color: `hsl(${hue} 75% 60%)` }}>✦</span></div></>}
      {watermark && !video && <div className="pill absolute top-2 right-2 px-2 py-0.5 bg-white/90 text-[10px] font-bold text-slate-500 rotate-[-4deg]">preview only</div>}
      <div className="absolute bottom-0 inset-x-0 px-2.5 py-2 bg-white/95 border-t border-slate-100"><p className="text-[12px] font-bold leading-tight text-slate-700">{title}</p><p className="text-[11px] text-slate-500">{kind}{video ? " · video — press play" : image && imgOk ? "" : " · placeholder art"}</p></div>
    </div>
  );
}
function Badge({ children, color = "#64748b" }: { children: React.ReactNode; color?: string }) {
  return <span className="pill inline-flex items-center gap-1 px-3 py-1 text-[11px] font-bold text-white" style={{ background: color }}>{children}</span>;
}
function SectionBar({ children, color = "#ff6b6b" }: { children: React.ReactNode; color?: string }) {
  return <div className="flex items-center gap-2"><span style={{ color }}><Icon name="spark" /></span><h2 className="condensed text-xl md:text-2xl px-1 py-2 flex-1 text-slate-700">{children}</h2></div>;
}

/** Image that hides itself if the URL is broken, so the colour/placeholder block behind it shows instead. */
function SafeImg({ src, alt, className, style }: { src: string; alt: string; className?: string; style?: React.CSSProperties }) {
  const [ok, setOk] = useState(true);
  useEffect(() => { setOk(true); }, [src]);
  if (!src || !ok) return null;
  return <img src={src} alt={alt} className={className} style={style} onError={() => setOk(false)} />;
}

/** Downscale an uploaded image on canvas, then upload the JPEG bytes —
    the stored value is an asset reference (`asset:<id>`), so the database
    never holds base64 blobs. */
function fileToAssetRef(file: File, kind: string, maxDim = 900): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const g = canvas.getContext("2d");
      if (!g) { reject(new Error("Canvas unavailable")); return; }
      g.drawImage(img, 0, 0, w, h);
      canvas.toBlob(b => { if (!b) { reject(new Error("Canvas unavailable")); return; } uploadAsset(b, kind).then(resolve, reject); }, "image/jpeg", 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file could not be read as an image.")); };
    img.src = url;
  });
}

type PayMethod = { label: string; link: string; instructions: string };
type CryptoWallet = { network: string; address: string; label: string };
/* Mirror of the server's network list (actions.ts CRYPTO_NETWORKS) — the
   server re-validates every value, this list only drives the pickers. */
const CRYPTO_NETWORKS: { id: string; name: string; addressHint: string }[] = [
  { id: "btc", name: "Bitcoin (BTC)", addressHint: "Starts with 1, 3 or bc1" },
  { id: "ltc", name: "Litecoin (LTC)", addressHint: "Starts with L, M, 3 or ltc1" },
  { id: "usdt-tron", name: "USDT (TRON / TRC-20)", addressHint: "Starts with T" },
  { id: "usdt-eth", name: "USDT (Ethereum / ERC-20)", addressHint: "Starts with 0x" },
  { id: "eth", name: "Ethereum (ETH)", addressHint: "Starts with 0x" },
  { id: "xmr", name: "Monero (XMR)", addressHint: "Starts with 4 or 8" },
  { id: "sol", name: "Solana (SOL)", addressHint: "Base58 address" },
  { id: "doge", name: "Dogecoin (DOGE)", addressHint: "Starts with D" },
];
const cryptoNetName = (id: string): string => CRYPTO_NETWORKS.find(n => n.id === id)?.name ?? id;
type Theme = { pfpUrl: string; bannerUrl: string; bgColor: string; panelColor: string; accent: string; accent2: string; headingColor: string; bodyColor: string; bgImageUrl: string; showcaseUrl: string; portfolioImages: Record<string, string>; paymentMethods: PayMethod[]; cryptoWallets: CryptoWallet[]; verifiedOnly: boolean };
function themeOf(c: Creator): Theme { return { pfpUrl: c.pfpUrl, bannerUrl: c.bannerUrl, bgColor: c.bgColor, panelColor: c.panelColor, accent: c.accent, accent2: c.accent2, headingColor: c.headingColor, bodyColor: c.bodyColor, bgImageUrl: c.bgImageUrl, showcaseUrl: c.showcaseUrl, portfolioImages: c.portfolioImages ?? {}, paymentMethods: c.paymentMethods ?? [], cryptoWallets: c.cryptoWallets ?? [], verifiedOnly: c.verifiedOnly ?? false }; }
function VerifiedBadge({ accent = "#0ea5e9" }: { accent?: string }) { return <span className="pill inline-flex items-center gap-1 px-2.5 py-0.5 text-[10px] font-bold text-white align-middle" style={{ background: accent }} title="Identity verified by the site owner">✓ Verified</span>; }

const SWATCHES = ["#ff6b6b", "#f472b6", "#fb923c", "#facc15", "#34d399", "#2ec4b6", "#38bdf8", "#a78bfa", "#e05260", "#334155", "#ffffff", "#fff5f5", "#fef9c3", "#f0f9ff", "#faf5ff", "#1e293b"];

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const safe = /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#cccccc";
  return (
    <div className="border border-slate-200 p-3 bg-white">
      <p className="text-xs font-bold text-slate-600">{label}</p>
      <div className="mt-2 flex items-center gap-2">
        <input type="color" value={safe} onChange={e => onChange(e.target.value)} className="w-11 h-10 shrink-0 cursor-pointer border border-slate-200 p-0.5 bg-white" aria-label={`${label} colour picker`} />
        <input value={value} onChange={e => onChange(e.target.value)} className="w-24 px-2 py-2 border border-slate-200 text-sm mono" aria-label={`${label} hex value`} spellCheck={false} />
        <span className="w-8 h-8 border border-slate-200 shrink-0" style={{ background: safe }} aria-hidden="true" />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">{SWATCHES.map(s => <button key={s} type="button" onClick={() => onChange(s)} className="w-6 h-6 border border-slate-300 hover:scale-110 transition-transform" style={{ background: s }} aria-label={`${label}: use swatch ${s}`} />)}</div>
    </div>
  );
}

function ImageSlot({ label, value, onChange, maxDim = 900, kind }: { label: string; value: string; onChange: (v: string) => void; maxDim?: number; kind: string }) {
  const [urlDraft, setUrlDraft] = useState("");
  const [err, setErr] = useState("");
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setErr("");
    try { onChange(await fileToAssetRef(f, kind, maxDim)); } catch (e) { setErr(String(e instanceof Error ? e.message : e)); }
  };
  const inputId = useMemo(() => `file-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${Math.random().toString(36).slice(2, 7)}`, [label]);
  return (
    <div className="border border-slate-200 p-3 bg-white">
      <p className="text-xs font-bold text-slate-600">{label}</p>
      {value ? (
        <div className="mt-2 relative border border-slate-200 overflow-hidden h-24 bg-slate-100">
          <SafeImg src={value} alt={`${label} preview`} className="w-full h-full object-cover" />
        </div>
      ) : <p className="mt-2 text-[12px] text-slate-400">No image yet — the placeholder or colour shows instead.</p>}
      <div className="mt-2 flex flex-wrap gap-2 items-center">
        <label htmlFor={inputId} className="btn-playful cursor-pointer px-3 py-2 bg-sky-500 text-white text-xs font-bold">Upload image</label>
        <input id={inputId} type="file" accept="image/*" className="hidden" onChange={e => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
        {value && <button type="button" onClick={() => onChange("")} className="btn-playful px-3 py-2 bg-white border border-rose-200 text-rose-500 text-xs font-bold" aria-label={`Remove ${label}`}>Remove</button>}
      </div>
      <div className="mt-2 flex gap-2">
        <input value={urlDraft} onChange={e => setUrlDraft(e.target.value)} placeholder="…or paste an image URL" className="flex-1 min-w-0 px-2 py-2 border border-slate-200 text-sm" aria-label={`${label} image URL`} />
        <button type="button" disabled={!urlDraft.trim()} onClick={() => { const v = urlDraft.trim(); if (!/^https?:\/\//i.test(v)) { setErr("Only http(s) image links work here — or upload the file instead."); return; } setErr(""); onChange(v); setUrlDraft(""); }} className="btn-playful px-3 py-2 bg-violet-500 text-white text-xs font-bold disabled:opacity-40" aria-label={`Use pasted URL for ${label}`}>Use URL</button>
      </div>
      {err && <p className="mt-1 text-[12px] font-bold text-rose-500">{err}</p>}
    </div>
  );
}

export function App() {
  const qc = useQueryClient();
  const route = useHashRoute();
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const state = useQuery({ queryKey: ["state"], queryFn: () => api.getState({}) });
  const act = useMutation({ mutationFn: async (v: { id: string; action: any; counterPrice?: number; note?: string }) => await api.actOnCommission(v as any), onSuccess: () => qc.invalidateQueries({ queryKey: ["state"] }), onError: (e) => alert(String(e)) });
  /* Session: the real session is the server's HttpOnly cookie — nothing is
     persisted client-side, so a login survives refresh via GET /api/session.
     `token` holds only the in-memory CSRF token (from the session response
     or a signUp/logIn response), which the API layer echoes back in the
     X-CSRF-Token header. No auth wall — the site stays fully browsable. */
  const [token, setToken] = useState<string>("");
  const session = useQuery({ queryKey: ["session"], queryFn: () => api.getSession({}) });
  const account: Account = session.data?.account ?? null;
  useEffect(() => { if (session.data) setToken(session.data.account ? session.data.csrfToken : ""); }, [session.data]); // eslint-disable-line
  const signIn = (t: string) => { setToken(t); qc.invalidateQueries({ queryKey: ["session"] }); };
  const logout = useMutation({ mutationFn: async () => await api.logOut({ token }), onSuccess: () => { setToken(""); qc.invalidateQueries({ queryKey: ["session"] }); navigate("/"); } });
  useEffect(() => { if (route.name === "account" && session.isSuccess && !session.data?.account) navigate("/login"); }, [route.name, session.isSuccess, session.data]); // eslint-disable-line
  if (state.isPending) return <div className="min-h-screen p-8 text-center bg-white text-sm font-semibold text-slate-500">Loading the toy shop… ✦ ★ ♥</div>;
  if (state.error || !state.data) return <div className="min-h-screen p-8 bg-white"><p className="font-bold">Could not load.</p><button className="btn-playful mt-3 px-4 py-2 border border-slate-200 bg-[#ff6b6b] text-white font-bold text-sm" onClick={() => state.refetch()}>Retry</button></div>;
  const data = state.data;
  const activeJob = data.commissions.find(c => c.id === selectedJob) ?? data.commissions.find(c => c.status === "in_progress") ?? data.commissions[0];
  /* Unique public slug per creator: name slug, de-collided with -2, -3… so a
     brand-new creator page never shadows an existing shop's URL. Plain
     derived value (NOT a hook — this sits below the loading early-returns). */
  const slugOf = (() => { const used = new Set<string>(); const m = new Map<string, string>(); for (const c of data.creators) { const base = creatorSlug(c); let s = base; let n = 2; while (used.has(s)) { s = `${base}-${n}`; n += 1; } used.add(s); m.set(c.id, s); } return m; })();
  const slugFor = (c: Creator): string => slugOf.get(c.id) ?? creatorSlug(c);
  const creator = route.name === "creator" ? data.creators.find(c => slugFor(c) === route.slug || c.id === route.slug) : undefined;
  const myCreator = account?.creatorId ? data.creators.find(c => c.id === account.creatorId) : undefined;
  /* Bottom tab bar — exactly four tabs, Instagram-style. Pages that are not
     tabs light up their nearest tab: creator pages under Search; Jobs,
     How It Works, Log in, Sign up and Account under My Profile. Signed out,
     My Profile is the door to Log in (and from there, Sign up). */
  const activeTab = route.name === "home" ? "home" : route.name === "search" || route.name === "creator" ? "search" : route.name === "vault" ? "vault" : "profile";
  const bottomTabs: { v: string; label: string; icon: string; color: string; go: () => void }[] = [
    { v: "home", label: "Home", icon: "home", color: "#ff6b6b", go: () => navigate("/") },
    { v: "search", label: "Search", icon: "search", color: "#34d399", go: () => navigate("/search") },
    { v: "vault", label: "Weekly Vault", icon: "gift", color: "#a78bfa", go: () => navigate("/vault") },
    { v: "profile", label: "My Profile", icon: "user", color: "#38bdf8", go: () => navigate(account ? "/account" : "/login") },
  ];
  const waitingCount = data.commissions.filter(c => ["requested", "countered", "brief", "quoted"].includes(c.status)).length;
  return (
    <div className="min-h-screen bg-[#fffef9] text-slate-700 [overflow-x:clip]">
      <main className="max-w-6xl mx-auto px-3 pb-10 pt-4">
        {route.name === "home" && <Home account={account} token={token} goHow={() => navigate("/how-it-works")} slugForId={(id) => slugOf.get(id) ?? id} />}
        {route.name === "search" && <SearchPage key={searchPath(route.text, route.cats, route.mode, route.sort)} taxonomy={data.taxonomy} creators={data.creators} slugFor={slugFor} initialText={route.text} initialCats={route.cats} initialMode={route.mode} initialSort={route.sort} />}
        {route.name === "creator" && creator && <CreatorPage creator={creator} taxonomy={data.taxonomy} account={account} token={token} back={() => navigate("/search")} onCreated={() => navigate("/jobs")} />}
        {route.name === "creator" && !creator && <NotFound />}
        {route.name === "jobs" && <Jobs data={data} selectedId={activeJob?.id ?? null} onSelect={setSelectedJob} act={act} token={token} account={account} />}
        {route.name === "vault" && <WeeklyVault data={data} account={account} token={token} />}
        {route.name === "how" && <HowItWorks goCreators={() => navigate("/search")} />}
        {route.name === "terms" && <TermsPage />}
        {route.name === "login" && <LoginPage onSignedIn={(t) => { signIn(t); navigate("/account"); }} goSignUp={() => navigate("/signup")} />}
        {route.name === "signup" && <SignUpPage onSignedIn={(t, acct) => { signIn(t); if (acct.accountType === "creator" && acct.creatorId) navigate(`/creators/${acct.creatorSlug ?? acct.creatorId}`); else navigate("/account"); }} goLogIn={() => navigate("/login")} />}
        {route.name === "account" && (account ? <AccountPage account={account} token={token} creator={myCreator} creatorSlug={myCreator ? slugFor(myCreator) : null} waitingCount={waitingCount} onLogOut={() => logout.mutate()} loggingOut={logout.isPending} /> : <p className="text-center text-sm font-semibold text-slate-500 py-10">One moment — checking your account… ✦</p>)}
        {route.name === "admin" && (account?.isAdmin || account?.role === "mod" ? <AdminPage token={token} isDev={!!account?.isAdmin} /> : <NotFound />)}
        {route.name === "notfound" && <NotFound />}
      </main>
      <footer className="bg-white mt-4"><Wavy color="#a5b4fc" /><div className="max-w-6xl mx-auto px-4 py-5 text-[13px] text-slate-500 flex flex-wrap gap-2 items-center"><span className="text-rose-400">♥</span> Live beta — invite-only test. Model v2: artists are paid directly on their own accounts; the platform locks the artwork until the balance is paid and keeps the job record. Standing is earned only — no cash value. <span className="pill bg-amber-100 text-amber-700 px-2 py-0.5 font-bold">7-day milestone target</span><span className="pill bg-sky-100 text-sky-700 px-2 py-0.5 font-bold">Deposit → Sketch → Vault → Unlock</span><span className="pill bg-amber-100 text-amber-700 px-2 py-0.5 font-bold">₿ Crypto accepted — you send it, the checker releases it</span><span className="pill bg-violet-100 text-violet-700 px-2 py-0.5 font-bold">Weekly Vault · both doors</span><button onClick={() => navigate("/how-it-works")} className="font-bold text-sky-600 underline underline-offset-2" aria-label="Read how it works">How it works →</button><button onClick={() => navigate("/terms")} className="font-bold text-violet-600 underline underline-offset-2" aria-label="Read the terms, privacy notes and launch checklist">Terms &amp; launch checklist →</button></div></footer>
      {/* Spacer so the fixed bottom tab bar never covers the footer */}
      <div aria-hidden="true" style={{ height: "calc(72px + env(safe-area-inset-bottom))" }} />
      {/* BOTTOM TAB BAR — fixed, Instagram-style, exactly four tabs. Centred
          on the app's content width at every viewport size; the safe-area
          padding keeps it clear of the iPhone home indicator. */}
      <nav aria-label="Main navigation" className="fixed bottom-0 inset-x-0 z-30 bg-white border-t-2 border-slate-200 shadow-[0_-4px_16px_rgba(100,116,139,0.08)]">
        <div className="max-w-6xl mx-auto px-2 grid grid-cols-4" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          {bottomTabs.map(t => {
            const active = activeTab === t.v;
            return (
              <button key={t.v} type="button" onClick={t.go} aria-label={t.v === "profile" && !account ? "My Profile — log in" : `Go to ${t.label}`} aria-current={active ? "page" : undefined} className="relative flex flex-col items-center justify-center gap-0.5 py-2 min-h-[60px] font-bold" style={{ color: active ? t.color : "#94a3b8" }}>
                {active && <span aria-hidden="true" className="absolute top-0 left-1/2 -translate-x-1/2 h-[3px] w-10" style={{ background: t.color }} />}
                {t.v === "profile" && account && myCreator?.pfpUrl ? (
                  <span className="relative w-6 h-6 overflow-hidden inline-flex items-center justify-center" style={{ background: myCreator.accent, outline: active ? `2px solid ${t.color}` : "none", outlineOffset: 1 }}><SafeImg src={myCreator.pfpUrl} alt="" className="absolute inset-0 w-full h-full object-cover" /></span>
                ) : (
                  <Icon name={t.icon} className="w-6 h-6" />
                )}
                <span className="text-[11px] leading-tight">{t.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

const AUTH_INPUT = "mt-1 w-full px-4 py-3 bg-white border border-slate-200 text-sm text-slate-700";
function FieldError({ msg }: { msg?: string }) { return msg ? <p className="mt-1 text-[12px] font-bold text-rose-500" role="alert">{msg}</p> : null; }

function LoginPage({ onSignedIn, goSignUp }: { onSignedIn: (token: string) => void; goSignUp: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [forgot, setForgot] = useState(false);
  const login = useMutation({ mutationFn: async () => await api.logIn({ email: email.trim(), password }), onSuccess: (r) => onSignedIn(r.token), onError: (e) => setErr(String(e instanceof Error ? e.message : e)) });
  const submit = (e: FormEvent) => { e.preventDefault(); setErr(""); if (!email.trim() || !password) { setErr("Pop in your email and password to log in."); return; } login.mutate(); };
  return (
    <section className="max-w-md mx-auto">
      <div className="bg-sky-50 px-5 py-5 border border-sky-100 relative overflow-hidden">
        <h1 className="display text-4xl leading-tight text-slate-700">Welcome back! ✿</h1>
        <p className="text-slate-500 mt-1">Log in to peek at your account. Just browsing? You never need an account for that.</p>
        <div className="absolute top-3 right-3 hidden sm:block"><Starburst color="#bae6fd" className="tilt-r">Hi again!</Starburst></div>
      </div>
      <form onSubmit={submit} className="square mt-4 bg-white border border-slate-100 p-5 md:p-6 shadow-[5px_5px_0_#dbeafe]" style={{ borderRadius: 0 }} aria-label="Log in">
        <div><label htmlFor="loginEmail" className="text-xs font-bold text-slate-600">Email</label><input id="loginEmail" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} className={AUTH_INPUT} placeholder="you@example.com" /></div>
        <div className="mt-3"><label htmlFor="loginPassword" className="text-xs font-bold text-slate-600">Password</label><input id="loginPassword" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className={AUTH_INPUT} placeholder="Your password" /></div>
        {err && <p className="mt-3 text-sm font-bold text-rose-500 bg-rose-50 border border-rose-100 px-3 py-2" role="alert">{err}</p>}
        <button type="submit" disabled={login.isPending} className="btn-playful mt-4 w-full py-3.5 bg-[#38bdf8] text-white font-bold text-base shadow-[4px_4px_0_#fde047] disabled:opacity-50" aria-label="Log in with email and password">{login.isPending ? "Logging in…" : "Log in →"}</button>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <button type="button" onClick={() => setForgot(f => !f)} className="text-sm font-bold text-sky-600 underline underline-offset-2" aria-label="Forgot your password?">Forgot password?</button>
          <button type="button" onClick={goSignUp} className="text-sm font-bold text-pink-500 underline underline-offset-2" aria-label="New here? Go to sign up">New here? Sign up →</button>
        </div>
        {forgot && <div className="mt-3"><Speech color="#fef9c3">Password reset isn't wired up yet — no email gets sent. If you're locked out, make a fresh account for now. Sorry! ♥</Speech></div>}
      </form>
    </section>
  );
}

function SignUpPage({ onSignedIn, goLogIn }: { onSignedIn: (token: string, account: NonNullable<Account>) => void; goLogIn: () => void }) {
  const qc = useQueryClient();
  const [accountType, setAccountType] = useState<"buyer" | "creator">("buyer");
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [shopName, setShopName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [over18, setOver18] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formErr, setFormErr] = useState("");
  const signup = useMutation({ mutationFn: async () => await api.signUp({ displayName: displayName.trim(), username: username.trim(), email: email.trim(), password, accountType, shopName: accountType === "creator" ? shopName.trim() : "", over18: true as const, inviteCode: inviteCode.trim(), fingerprint: deviceFingerprint() }), onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["state"] }); onSignedIn(r.token, r.account); }, onError: (e) => setFormErr(String(e instanceof Error ? e.message : e)) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!displayName.trim()) errs.displayName = "What should we call you?";
    if (username.trim().length < 3) errs.username = "Usernames need at least 3 characters.";
    else if (!/^[a-zA-Z0-9_.-]+$/.test(username.trim())) errs.username = "Letters, numbers, dots, dashes and underscores only.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errs.email = "That email doesn't look quite right.";
    if (password.length < 15) errs.password = "Passwords need at least 15 characters — a short sentence makes a great one.";
    if (confirm !== password) errs.confirm = "Passwords don't match — one more try.";
    if (!over18) errs.over18 = "Please confirm you're 18 or older to join.";
    setErrors(errs); setFormErr("");
    if (Object.keys(errs).length === 0) signup.mutate();
  };
  return (
    <section className="max-w-md mx-auto">
      <div className="bg-pink-50 px-5 py-5 border border-pink-100 relative overflow-hidden">
        <h1 className="display text-4xl leading-tight text-slate-700">Join the toy shop ✿</h1>
        <p className="text-slate-500 mt-1">One little account. Buyers get a tidy home for their commissions; creators get their very own page.</p>
        <div className="absolute top-3 right-3 hidden sm:block"><Starburst color="#fbcfe8" className="tilt-l">New!</Starburst></div>
      </div>
      <form onSubmit={submit} className="square mt-4 bg-white border border-slate-100 p-5 md:p-6 shadow-[5px_5px_0_#ffe4ec]" style={{ borderRadius: 0 }} aria-label="Sign up" noValidate>
        <p className="text-xs font-bold text-slate-600">I'm joining as a…</p>
        <div className="mt-2 grid grid-cols-2 gap-2" role="group" aria-label="Account type">
          <button type="button" onClick={() => setAccountType("buyer")} aria-pressed={accountType === "buyer"} className="btn-playful px-4 py-3 font-bold text-sm border" style={accountType === "buyer" ? { background: "#38bdf8", color: "#fff", borderColor: "#38bdf8", boxShadow: "3px 3px 0 #bae6fd" } : { background: "#fff", color: "#64748b", borderColor: "#e2e8f0" }}>🛍 Buyer</button>
          <button type="button" onClick={() => setAccountType("creator")} aria-pressed={accountType === "creator"} className="btn-playful px-4 py-3 font-bold text-sm border" style={accountType === "creator" ? { background: "#f472b6", color: "#fff", borderColor: "#f472b6", boxShadow: "3px 3px 0 #fbcfe8" } : { background: "#fff", color: "#64748b", borderColor: "#e2e8f0" }}>🎨 Creator</button>
        </div>
        <p className="mt-2 text-[13px] text-slate-500">{accountType === "creator" ? "Creators get their own public page with its own web address, ready to decorate." : "Buyers can commission any creator and follow their jobs from one place."}</p>
        <div className="mt-4"><label htmlFor="suName" className="text-xs font-bold text-slate-600">Display name</label><input id="suName" autoComplete="name" value={displayName} onChange={e => setDisplayName(e.target.value)} className={AUTH_INPUT} placeholder="e.g. Alex Rivera" /><FieldError msg={errors.displayName} /></div>
        <div className="mt-3"><label htmlFor="suUsername" className="text-xs font-bold text-slate-600">Username</label><input id="suUsername" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} className={AUTH_INPUT} placeholder="e.g. alex_draws" /><FieldError msg={errors.username} /></div>
        <div className="mt-3"><label htmlFor="suEmail" className="text-xs font-bold text-slate-600">Email</label><input id="suEmail" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} className={AUTH_INPUT} placeholder="you@example.com" /><FieldError msg={errors.email} /></div>
        <div className="mt-3"><label htmlFor="suInvite" className="text-xs font-bold text-slate-600">Invite code</label><input id="suInvite" autoComplete="off" value={inviteCode} onChange={e => setInviteCode(e.target.value)} className={AUTH_INPUT + " mono"} placeholder="e.g. ABCDE-FGHIJ-KLMNP" /><p className="mt-1 text-[12px] text-slate-400">This test is invite-only — you'll need a code from the site owner to join.</p></div>
        {accountType === "creator" && <div className="mt-3"><label htmlFor="suShop" className="text-xs font-bold text-slate-600">Page / shop name</label><input id="suShop" value={shopName} onChange={e => setShopName(e.target.value)} className={AUTH_INPUT} placeholder={displayName.trim() ? `Defaults to “${displayName.trim()}”` : "Your shop's name"} /><p className="mt-1 text-[12px] text-slate-400">Your page address will be <span className="mono font-bold text-slate-500">#/creators/{slugify((shopName.trim() || displayName.trim()) || "your-shop")}</span></p></div>}
        <div className="mt-3"><label htmlFor="suPassword" className="text-xs font-bold text-slate-600">Password</label><input id="suPassword" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} className={AUTH_INPUT} placeholder="15+ characters — a little sentence works great" /><FieldError msg={errors.password} /></div>
        <div className="mt-3"><label htmlFor="suConfirm" className="text-xs font-bold text-slate-600">Confirm password</label><input id="suConfirm" type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} className={AUTH_INPUT} placeholder="Same password again" /><FieldError msg={errors.confirm} /></div>
        <label className="mt-4 flex items-start gap-2 text-sm font-semibold text-slate-600 cursor-pointer"><input type="checkbox" checked={over18} onChange={e => setOver18(e.target.checked)} className="mt-0.5 w-4 h-4 shrink-0" /> I confirm I'm 18 or older — this is a platform for adult commissions.</label>
        <p className="mt-2 text-[12px] text-slate-500">By creating an account you agree to the <button type="button" onClick={() => navigate("/terms")} className="font-bold text-violet-600 underline underline-offset-2" aria-label="Read the terms and conditions">Terms &amp; Conditions</button>.</p>
        <FieldError msg={errors.over18} />
        <p className="mt-3 text-[12px] font-semibold text-amber-700 bg-amber-50 border border-amber-100 px-3 py-2">Beta accounts only — please don't reuse a password from anywhere else. Passwords are stored as a salted one-way hash, never in plain text.</p>
        {formErr && <p className="mt-3 text-sm font-bold text-rose-500 bg-rose-50 border border-rose-100 px-3 py-2" role="alert">{formErr}</p>}
        <button type="submit" disabled={signup.isPending} className="btn-playful mt-4 w-full py-3.5 bg-[#ff6b6b] text-white font-bold text-base shadow-[4px_4px_0_#fde047] disabled:opacity-50" aria-label="Create my account">{signup.isPending ? "Creating your account…" : accountType === "creator" ? "Create my creator page →" : "Create my account →"}</button>
        <div className="mt-4 text-center"><button type="button" onClick={goLogIn} className="text-sm font-bold text-sky-600 underline underline-offset-2" aria-label="Already have an account? Go to log in">Already have an account? Log in →</button></div>
      </form>
    </section>
  );
}

function AccountPage({ account, token, creator, creatorSlug, waitingCount, onLogOut, loggingOut }: { account: NonNullable<Account>; token: string; creator?: Creator; creatorSlug: string | null; waitingCount: number; onLogOut: () => void; loggingOut: boolean }) {
  const qc = useQueryClient();
  const isCreator = account.accountType === "creator";
  const [perkMsg, setPerkMsg] = useState("");
  const buyPerk = useMutation({ mutationFn: async (perk: "banner_frame" | "name_glow" | "portfolio_tiles" | "vault_slots") => await api.buyPerk({ token, perk }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["session"] }); qc.invalidateQueries({ queryKey: ["state"] }); setPerkMsg("Perk applied to your page. Standing well spent! ⭐"); }, onError: (e) => setPerkMsg(String(e instanceof Error ? e.message : e)) });
  const levelProgress = account.nextLevelAt ? Math.min(100, Math.round((account.lifetimeEarned / account.nextLevelAt) * 100)) : 100;
  const myPosts = useQuery({ queryKey: ["myPosts", token], queryFn: () => api.listMyPosts({ token }), enabled: isCreator && token.length > 0 });
  const delPost = useMutation({ mutationFn: async (postId: string) => await api.deletePost({ token, postId }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["myPosts"] }); qc.invalidateQueries({ queryKey: ["posts"] }); } });
  const [confirmId, setConfirmId] = useState<string | null>(null);
  return (
    <section className="max-w-2xl mx-auto">
      <div className="px-5 py-5 border relative overflow-hidden" style={{ background: creator ? `${creator.accent}14` : "#f5f3ff", borderColor: creator ? `${creator.accent}55` : "#ede9fe" }}>
        <div className="flex gap-4 items-center flex-wrap">
          <div className="relative w-16 h-16 shrink-0 overflow-hidden flex items-center justify-center text-white display text-2xl" style={{ background: creator?.accent ?? "#a78bfa" }}>{creator?.pfpUrl ? <SafeImg src={creator.pfpUrl} alt={`${account.displayName}'s profile picture`} className="absolute inset-0 w-full h-full object-cover" /> : account.displayName.slice(0, 1).toUpperCase()}</div>
          <div className="min-w-0">
            <h1 className="display text-3xl leading-tight text-slate-700">Hey, {account.displayName}! ✿</h1>
            <p className="text-slate-500 text-sm mt-0.5">@{account.username} · {account.email}</p>
            <span className="pill mt-2 inline-block px-3 py-1 text-[11px] font-bold text-white" style={{ background: isCreator ? "#f472b6" : "#38bdf8" }}>{isCreator ? "🎨 Creator account" : "🛍 Buyer account"}</span>
            <span className="pill mt-2 ml-2 inline-block px-3 py-1 text-[11px] font-bold bg-amber-100 text-amber-700">⭐ Standing: {account.credits} — earned only, never purchasable, never transferable, no cash value</span>
            {account.verified && <span className="pill mt-2 ml-2 inline-block px-3 py-1 text-[11px] font-bold bg-sky-500 text-white">✓ Verified</span>}
            <span className="pill mt-2 ml-2 inline-block px-3 py-1 text-[11px] font-bold bg-violet-100 text-violet-700">Level {account.level} · {account.levelName}</span>
            {account.isAdmin && <span className="pill mt-2 ml-2 inline-block px-3 py-1 text-[11px] font-bold bg-slate-700 text-white">🛠 Dev account — site owner</span>}
            {!account.isAdmin && account.role === "mod" && <span className="pill mt-2 ml-2 inline-block px-3 py-1 text-[11px] font-bold bg-teal-600 text-white">🛡 Moderator</span>}
          </div>
        </div>
      </div>
      {/* PROFILE HUB — Inbox & Jobs and friends live here now, as tappable
          rows. #/jobs keeps its own URL; this is the front door to it. */}
      <nav className="square mt-4 bg-white border border-slate-100 shadow-[5px_5px_0_#dbeafe]" style={{ borderRadius: 0 }} aria-label="My profile sections">
        <h2 className="display text-2xl text-slate-700 px-5 pt-5">Your stuff</h2>
        <div className="mt-2 divide-y divide-slate-100">
          <button onClick={() => navigate("/jobs")} className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-sky-50" aria-label="Open my inbox and jobs">
            <span className="text-2xl" aria-hidden="true">📬</span>
            <span className="flex-1 min-w-0"><span className="block font-bold text-slate-700">Inbox &amp; Jobs</span><span className="block text-[13px] text-slate-500">Requests, briefs, delivery clocks and the money trail for every commission.</span></span>
            {waitingCount > 0 && <span className="pill bg-sky-500 text-white px-3 py-1 text-[11px] font-bold">{waitingCount} waiting</span>}
            <span className="font-bold text-slate-400" aria-hidden="true">→</span>
          </button>
          {isCreator && creatorSlug && (
            <button onClick={() => navigate(`/creators/${creatorSlug}`)} className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-pink-50" aria-label="Open my creator page">
              <span className="text-2xl" aria-hidden="true">🎨</span>
              <span className="flex-1 min-w-0"><span className="block font-bold text-slate-700">My creator page</span><span className="block text-[13px] text-slate-500">Your public shop — decorate it, post offers, take commissions.</span></span>
              <span className="font-bold text-slate-400" aria-hidden="true">→</span>
            </button>
          )}
          <button onClick={() => navigate("/how-it-works")} className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-amber-50" aria-label="Read how it works">
            <span className="text-2xl" aria-hidden="true">📖</span>
            <span className="flex-1 min-w-0"><span className="block font-bold text-slate-700">How It Works</span><span className="block text-[13px] text-slate-500">Direct payments, milestones, the artwork Vault, standing and the Weekly Vault, in plain words.</span></span>
            <span className="font-bold text-slate-400" aria-hidden="true">→</span>
          </button>
          <button onClick={() => navigate("/terms")} className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-violet-50" aria-label="Read the terms and launch checklist">
            <span className="text-2xl" aria-hidden="true">📜</span>
            <span className="flex-1 min-w-0"><span className="block font-bold text-slate-700">Terms &amp; Launch Checklist</span><span className="block text-[13px] text-slate-500">The terms, privacy notes, and what must be sorted before real money.</span></span>
            <span className="font-bold text-slate-400" aria-hidden="true">→</span>
          </button>
          {(account.isAdmin || account.role === "mod") && (
            <button onClick={() => navigate("/admin")} className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-slate-100 bg-slate-50" aria-label="Open staff controls">
              <span className="text-2xl" aria-hidden="true">🛡</span>
              <span className="flex-1 min-w-0"><span className="block font-bold text-slate-700">{account.isAdmin ? "Dev controls" : "Moderator controls"}</span><span className="block text-[13px] text-slate-500">{account.isAdmin ? "Invite codes, roles, reports, quarantine, bans, refund balances, Trust Pool covers and the moderation log." : "Reports, quarantine, bans, strikes and the moderation log."}</span></span>
              <span className="font-bold text-slate-400" aria-hidden="true">→</span>
            </button>
          )}
        </div>
      </nav>
      {/* STANDING — the game layer. Earned only, never purchasable, never
          transferable, no cash value. Levels gate quote caps + Vault. */}
      <div className="square mt-4 bg-white border border-amber-100 p-5 shadow-[5px_5px_0_#fef3c7]" style={{ borderRadius: 0 }}>
        <h2 className="display text-2xl text-slate-700">⭐ Standing &amp; level</h2>
        <p className="text-sm text-slate-500 mt-1">Standing is your reputation score, earned by finishing jobs well — <strong>earned only, never purchasable, never transferable between people, and it has no cash value</strong>. It's also your bond: a ban burns it all.</p>
        <div className="mt-3 flex flex-wrap gap-2 items-center">
          <span className="pill px-3 py-1 text-[12px] font-bold bg-amber-100 text-amber-700">Balance: {account.credits} standing</span>
          <span className="pill px-3 py-1 text-[12px] font-bold bg-violet-100 text-violet-700">Lifetime earned: {account.lifetimeEarned}</span>
          <span className="pill px-3 py-1 text-[12px] font-bold bg-sky-100 text-sky-700">Level {account.level} · {account.levelName}</span>
          {account.verified ? <span className="pill px-3 py-1 text-[12px] font-bold bg-sky-500 text-white">✓ Verified</span> : <span className="pill px-3 py-1 text-[12px] font-bold bg-slate-100 text-slate-500">Not verified yet — the owner verifies testers by hand</span>}
        </div>
        <div className="mt-3">
          <div className="flex justify-between text-[12px] font-bold text-slate-500"><span>{account.nextLevelAt ? `Progress to Level ${account.level + 1}` : "Top level reached"}</span><span>{account.nextLevelAt ? `${account.lifetimeEarned} / ${account.nextLevelAt}` : "Pillar ⭐"}</span></div>
          <div className="mt-1 h-3 bg-slate-100 border border-slate-200"><div className="h-full" style={{ width: `${levelProgress}%`, background: "#f59e0b" }} /></div>
        </div>
        <p className="mt-2 text-[13px] text-slate-500">Earn: job completed as artist +40 · as buyer +15 · on-time delivery +15 · sketch approved with no revision +5 · first job +25 · becoming Verified +20. Seller quote caps rise with level (L1 $75 · L2 $200 · L3 $600 · L4 $2,000 · L5 no cap); Weekly Vault submissions open at Level 2.</p>
        {isCreator && (
          <div className="mt-4">
            <h3 className="text-sm font-bold text-slate-600">Spend standing — platform perks only</h3>
            <div className="mt-2 grid sm:grid-cols-2 gap-2">
              {([["banner_frame", "🖼 Banner frame", 60, account.perks.bannerFrame, "A candy frame around your storefront banner"], ["name_glow", "✨ Name glow", 120, account.perks.nameGlow, "Your shop name glows on your page, search and posts"], ["portfolio_tiles", "🎨 +4 portfolio tiles", 150, false, `Adds 4 portfolio slots (you have +${account.perks.extraPortfolioTiles})`], ["vault_slots", "🎁 +2 Vault slots / week", 200, false, `Adds 2 Weekly Vault submissions per week (you have +${account.perks.extraVaultSlots})`]] as const).map(([key, label, price, owned, blurb]) => (
                <div key={key} className="border border-slate-200 p-3 flex items-start gap-2">
                  <div className="flex-1 min-w-0"><p className="font-bold text-sm text-slate-700">{label} <span className="mono text-amber-600">{price} ⭐</span></p><p className="text-[12px] text-slate-500 mt-0.5">{blurb}</p></div>
                  {owned ? <span className="pill px-3 py-1 text-[11px] font-bold bg-emerald-100 text-emerald-700 shrink-0">Owned ✓</span> : <button type="button" disabled={buyPerk.isPending} onClick={() => { setPerkMsg(""); buyPerk.mutate(key); }} className="btn-playful px-3 py-1.5 bg-amber-400 text-slate-700 text-[11px] font-bold disabled:opacity-50 shrink-0" aria-label={`Buy perk ${label} for ${price} standing`}>Buy</button>}
                </div>
              ))}
            </div>
            {perkMsg && <p className="mt-2 text-sm font-bold text-slate-600" role="status">{perkMsg}</p>}
          </div>
        )}
        {!isCreator && <p className="mt-3 text-[13px] text-slate-500">Perks decorate creator pages — buyers earn standing toward trust and levels.</p>}
      </div>
      {account.refundDebt > 0 && (
        <div className="square mt-4 bg-rose-50 border-2 border-rose-300 p-5" style={{ borderRadius: 0 }} role="note" aria-label="Your refund balance">
          <h2 className="display text-2xl text-rose-600">💸 You owe a refund balance of {money(account.refundDebt)}</h2>
          <p className="mt-2 text-sm text-slate-600">Refunds on direct payments are the seller's own obligation — the platform never held the money, so it can't send it back for you. While this balance stands, <strong>new commissions and quotes are paused</strong> on your account. Settle the refund with the buyer, then ask the site owner to clear the balance. If the Trust Pool already covered your buyer, this is the amount the pool paid out for you.</p>
        </div>
      )}
      {account.strikes.length > 0 && (
        <div className="square mt-4 bg-rose-50 border border-rose-200 p-5" style={{ borderRadius: 0 }} role="note" aria-label="Your strikes">
          <h2 className="display text-2xl text-rose-600">⚠ You have {account.strikes.length} {account.strikes.length === 1 ? "strike" : "strikes"}</h2>
          <ul className="mt-2 space-y-1.5 text-sm text-slate-600">{account.strikes.map((st, i) => <li key={i} className="border-b border-dashed border-rose-200 pb-1.5">{st.note} <span className="text-[12px] text-slate-400">· {new Date(st.createdAt).toLocaleDateString()}</span></li>)}</ul>
          <p className="mt-2 text-[13px] text-slate-500">Strikes are part of the enforcement ladder: warning → strike → restriction → person-ban. If a strike looks wrong, talk to the site owner.</p>
        </div>
      )}
      {isCreator && creator && creatorSlug && (
        <div className="square mt-4 bg-white border border-pink-100 p-5 shadow-[5px_5px_0_#ffe4ec]" style={{ borderRadius: 0 }}>
          <h2 className="display text-2xl text-slate-700">Your public page</h2>
          <p className="text-sm text-slate-500 mt-1">This is the address you hand to your audience: <span className="mono font-bold text-slate-600">#/creators/{creatorSlug}</span></p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => navigate(`/creators/${creatorSlug}`)} className="btn-playful px-5 py-2.5 font-bold text-sm text-white" style={{ background: creator.accent }} aria-label="View my public creator page">Visit my page →</button>
            <button onClick={() => navigate(`/creators/${creatorSlug}`)} className="btn-playful px-5 py-2.5 font-bold text-sm bg-white border border-violet-200 text-violet-600" aria-label="Customize my page — opens my page where the customizer lives">🎨 Customize my page</button>
          </div>
          <p className="mt-2 text-[12px] text-slate-400">The customizer sits at the top of your page — colours, pictures, banner and pfp are all yours.</p>
        </div>
      )}
      {isCreator && !creator && <p className="mt-4 text-sm font-semibold text-slate-500 bg-amber-50 border border-amber-100 px-4 py-3">Your creator page is still being set up — give it a moment and refresh.</p>}
      {isCreator && (
        <div className="square mt-4 bg-white border border-slate-100 p-5 shadow-[5px_5px_0_#fef3c7]" style={{ borderRadius: 0 }}>
          <h2 className="display text-2xl text-slate-700">My offer posts</h2>
          <p className="text-sm text-slate-500 mt-1">Everything you've posted to the Home feed. New offers are posted from your creator page.</p>
          {myPosts.isPending ? <p className="mt-3 text-sm font-semibold text-slate-500">Loading your posts… ✦</p>
            : myPosts.error ? <p className="mt-3 text-sm font-bold text-rose-500" role="alert">{String(myPosts.error instanceof Error ? myPosts.error.message : myPosts.error)}</p>
            : (myPosts.data?.posts ?? []).length === 0 ? (
              <div className="mt-3">
                <p className="text-sm text-slate-500">No posts yet — your feed spot is empty.</p>
                {creatorSlug && <button onClick={() => navigate(`/creators/${creatorSlug}`)} className="btn-playful mt-3 px-5 py-2.5 font-bold text-sm text-white" style={{ background: creator?.accent ?? "#f472b6" }} aria-label="Go to my page to post an offer">Post your first offer →</button>}
              </div>
            ) : (
              <ul className="mt-3 divide-y divide-slate-100">
                {(myPosts.data?.posts ?? []).map(p => (
                  <li key={p.id} className="py-3 flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-slate-700 leading-snug">{p.title}</p>
                      <p className="text-[12px] font-semibold text-slate-400 mt-0.5">{relTime(p.createdAt)}{p.priceNote ? ` · ${p.priceNote}` : ""}{p.categories.length > 0 ? ` · ${p.categories.join(", ")}` : ""}</p>
                      <p className="text-sm text-slate-500 mt-1 line-clamp-2">{p.body}</p>
                    </div>
                    {confirmId === p.id ? (
                      <span className="flex flex-col gap-1.5 shrink-0">
                        <button type="button" disabled={delPost.isPending} onClick={() => { delPost.mutate(p.id); setConfirmId(null); }} className="btn-playful px-3 py-1.5 bg-rose-500 text-white text-[11px] font-bold disabled:opacity-50" aria-label={`Confirm delete of post ${p.title}`}>{delPost.isPending ? "Deleting…" : "Yes, delete"}</button>
                        <button type="button" onClick={() => setConfirmId(null)} className="btn-playful px-3 py-1.5 bg-white border border-slate-200 text-slate-500 text-[11px] font-bold" aria-label="Cancel deleting this post">Keep it</button>
                      </span>
                    ) : (
                      <button type="button" onClick={() => setConfirmId(p.id)} className="btn-playful px-3 py-1.5 bg-white border border-rose-200 text-rose-500 text-[11px] font-bold shrink-0" aria-label={`Delete my post ${p.title}`}>Delete</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          {delPost.error && <p className="mt-2 text-sm font-bold text-rose-500" role="alert">{String(delPost.error instanceof Error ? delPost.error.message : delPost.error)}</p>}
        </div>
      )}
      <div className="mt-5 flex justify-end">
        <button onClick={onLogOut} disabled={loggingOut} className="btn-playful px-5 py-2.5 font-bold text-sm bg-white border border-rose-200 text-rose-500 disabled:opacity-50" aria-label="Log out of my account">{loggingOut ? "Logging out…" : "Log out"}</button>
      </div>
    </section>
  );
}

type TaxonomyItem = State["taxonomy"][number];
const GROUP_LABEL: Record<string, string> = { medium: "By what they make", subject: "By subject & style" };
const GROUP_COLOR: Record<string, string> = { medium: "#38bdf8", subject: "#f472b6" };

/** Grouped category chip multi-select, fed by the server taxonomy. Used by
    Search (no cap) and the page customizer (max 6). */
function CategoryChips({ taxonomy, selected, onToggle, max }: { taxonomy: TaxonomyItem[]; selected: string[]; onToggle: (name: string) => void; max?: number }) {
  const full = max !== undefined && selected.length >= max;
  return (
    <div className="space-y-3">
      {(["medium", "subject"] as const).map(g => (
        <fieldset key={g}>
          <legend className="text-xs font-bold text-slate-600">{GROUP_LABEL[g]}</legend>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {taxonomy.filter(t => t.group === g).map(t => {
              const on = selected.includes(t.name);
              const disabled = !on && full;
              return <button key={t.name} type="button" disabled={disabled} onClick={() => onToggle(t.name)} aria-pressed={on} aria-label={`${on ? "Remove category" : "Add category"} ${t.name}`} className="pill btn-playful px-3 py-1.5 text-[11px] font-bold border disabled:opacity-40" style={on ? { background: GROUP_COLOR[g], color: "#fff", borderColor: GROUP_COLOR[g], boxShadow: `2px 2px 0 ${GROUP_COLOR[g]}44` } : { background: "#fff", color: "#475569", borderColor: "#e2e8f0" }}>{on ? "✓ " : ""}{t.name}</button>;
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function SearchPage({ taxonomy, creators, slugFor, initialText, initialCats, initialMode, initialSort }: { taxonomy: TaxonomyItem[]; creators: Creator[]; slugFor: (c: Creator) => string; initialText: string; initialCats: string[]; initialMode: "any" | "all"; initialSort: SearchSort }) {
  const known = useMemo(() => new Set(taxonomy.map(t => t.name)), [taxonomy]);
  const [text, setText] = useState(initialText);
  const [debounced, setDebounced] = useState(initialText);
  const [cats, setCats] = useState<string[]>(() => initialCats.filter(c => known.has(c)));
  const [mode, setMode] = useState<"any" | "all">(initialMode);
  const [sort, setSort] = useState<SearchSort>(initialSort);
  useEffect(() => { const t = setTimeout(() => setDebounced(text), 300); return () => clearTimeout(t); }, [text]);
  /* Keep the URL honest as filters change — replaceState, so no history
     spam and no remount loop; Back/Forward still re-parse the hash. */
  useEffect(() => { window.history.replaceState(null, "", `#${searchPath(debounced, cats, mode, sort)}`); }, [debounced, cats, mode, sort]);
  const search = useQuery({ queryKey: ["searchCreators", debounced, cats, mode, sort], queryFn: () => api.searchCreators({ text: debounced, categories: cats, matchMode: mode, sort }) });
  const toggle = (name: string) => setCats(prev => prev.includes(name) ? prev.filter(c => c !== name) : [...prev, name]);
  const clearAll = () => { setText(""); setDebounced(""); setCats([]); setMode("any"); setSort("relevance"); };
  const hasFilters = text.trim() !== "" || cats.length > 0 || mode !== "any" || sort !== "relevance";
  const results = search.data?.results ?? [];
  /* Default state — no text, no categories, default sort — IS the old
     Creators directory: browsing everyone, with the full directory cards.
     Any filter narrows into the SQL search results below. */
  const browsing = debounced.trim() === "" && cats.length === 0 && sort === "relevance";
  return (
    <section>
      <div className="bg-emerald-50 px-5 py-5 border border-emerald-100 relative overflow-hidden">
        <h1 className="display text-4xl leading-tight text-slate-700">Creator shops 🔎</h1>
        <p className="text-slate-500 mt-1 max-w-xl">Every shop lives here — browse them all, or search by name or username and narrow by the kind of work you're dreaming of. No account needed — peeking is free.</p>
        <div className="absolute top-3 right-3 hidden sm:block"><Starburst color="#a7f3d0" className="tilt-r">Peek away!</Starburst></div>
      </div>
      <div className="square mt-4 bg-white border border-slate-100 p-4 md:p-5 shadow-[5px_5px_0_#d1fae5]" style={{ borderRadius: 0 }}>
        <label htmlFor="searchText" className="text-xs font-bold text-slate-600">Name or username</label>
        <input id="searchText" value={text} onChange={e => setText(e.target.value)} placeholder="Try “velv”, a username, a shop name…" className="mt-1 w-full px-4 py-3 bg-white border border-slate-200 text-sm text-slate-700" />
        <div className="mt-4">
          <p className="text-xs font-bold text-slate-600 mb-2">Categories {cats.length > 0 && <span className="text-emerald-600">· {cats.length} picked</span>}</p>
          <CategoryChips taxonomy={taxonomy} selected={cats} onToggle={toggle} />
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <p className="text-xs font-bold text-slate-600 mb-1.5" id="matchModeLabel">When several categories are picked</p>
            <div className="flex gap-2" role="group" aria-labelledby="matchModeLabel">
              <button type="button" onClick={() => setMode("any")} aria-pressed={mode === "any"} className="pill btn-playful px-4 py-2 text-xs font-bold border" style={mode === "any" ? { background: "#34d399", color: "#fff", borderColor: "#34d399" } : { background: "#fff", color: "#64748b", borderColor: "#e2e8f0" }}>Any of these</button>
              <button type="button" onClick={() => setMode("all")} aria-pressed={mode === "all"} className="pill btn-playful px-4 py-2 text-xs font-bold border" style={mode === "all" ? { background: "#34d399", color: "#fff", borderColor: "#34d399" } : { background: "#fff", color: "#64748b", borderColor: "#e2e8f0" }}>All of these</button>
            </div>
          </div>
          <div>
            <label htmlFor="searchSort" className="text-xs font-bold text-slate-600">Sort by</label>
            <select id="searchSort" value={sort} onChange={e => setSort(e.target.value as SearchSort)} className="mt-1 block px-3 py-2.5 bg-white border border-slate-200 text-sm text-slate-700">
              <option value="relevance">Relevance</option>
              <option value="name">Name A–Z</option>
              <option value="newest">Newest creators</option>
            </select>
          </div>
          {hasFilters && <button type="button" onClick={clearAll} className="btn-playful px-4 py-2.5 bg-white border border-rose-200 text-rose-500 font-bold text-xs" aria-label="Clear all search filters">✕ Clear filters</button>}
        </div>
      </div>
      <div className="mt-5" aria-live="polite">
        {browsing ? (
          <div>
            <Speech color="#f0f9ff">Tip: every shop is different — that's the whole point! Pick the vibe you love. ♥</Speech>
            <p className="text-sm font-bold text-slate-600">{creators.length} creator {creators.length === 1 ? "shop" : "shops"} — no feed, no ads, no discovery maze. Each one is a little room of its own ✿</p>
            {creators.length === 0 ? <p className="mt-3 text-sm font-semibold text-slate-500">The shops are still setting up — one moment… ✦</p> : (
              <div className="mt-3 grid gap-5 md:grid-cols-3">
                {creators.map((c, idx) => (
                  <article key={c.id} className={`square bg-white border border-slate-100 p-1 ${idx === 1 ? "md:translate-y-3" : ""}`} style={{ boxShadow: `5px 5px 0 ${c.accent}33`, borderRadius: 0 }}>
                    {c.bannerUrl ? <div className="relative h-16 overflow-hidden" style={{ background: c.accent }}><SafeImg src={c.bannerUrl} alt="" className="absolute inset-0 w-full h-full object-cover" /></div> : <div className="h-2.5" style={{ background: c.accent }} />}
                    <div className="p-4">
                      <div className="flex gap-3"><div className="relative w-16 h-16 shrink-0 overflow-hidden flex items-center justify-center text-white display text-2xl" style={{ background: c.accent }}>{c.pfpUrl ? <SafeImg src={c.pfpUrl} alt={`${c.name}'s profile picture`} className="absolute inset-0 w-full h-full object-cover" /> : c.name.slice(0, 1)}<span className="absolute top-0 right-0 text-amber-400 text-base z-10">★</span></div><div className="min-w-0 flex-1"><h2 className="display text-[24px] leading-tight truncate text-slate-700" style={{ textShadow: c.nameGlow ? `0 0 12px ${c.accent2}` : undefined }}>{c.name}</h2><p className="text-[12px] font-semibold text-slate-400">{c.handle}</p><div className="mt-1 flex flex-wrap gap-1.5">{c.verified && <VerifiedBadge accent={c.accent} />}<span className="pill px-2 py-0.5 text-[10px] font-bold bg-violet-100 text-violet-700">⭐ L{c.level} {c.levelName}</span></div>{c.status !== "open" && <div className="mt-1.5"><span className="pill bg-amber-100 text-amber-700 px-3 py-1 text-[11px] font-bold tilt-r inline-block">◐ Waitlist</span></div>}</div></div>
                      <p className="mt-3 text-[15px] font-semibold leading-snug text-slate-600">{c.tagline}</p>
                      {c.categories.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{c.categories.map(cat => <button key={cat} type="button" onClick={() => toggle(cat)} className="pill px-2.5 py-1 text-[10px] font-bold border bg-white hover:bg-emerald-50" style={{ borderColor: `${c.accent}88`, color: "#475569" }} aria-label={`Filter shops by category ${cat}`}>{cat}</button>)}</div>}
                      <div className="mt-3 grid grid-cols-2 gap-2">{c.portfolio.slice(0, 2).map(p => <ArtTile key={p.title} hue={p.hue} title={p.title} kind={p.kind} image={c.portfolioImages?.[p.title]} />)}</div>
                      <div className="mt-4 bg-amber-50 border border-amber-100 text-sm overflow-hidden"><div className="flex justify-between px-3 py-2"><span className="font-semibold text-slate-500">From</span><span className="font-bold text-slate-700 mono">{money(Math.min(...c.prices.map(p => p.price)))}</span></div><div className="px-3 py-2 border-t border-amber-100 text-slate-500 truncate">{c.turnaround.split("·")[0]}</div></div>
                      <button className="btn-playful mt-4 w-full py-3 font-bold text-[15px] text-white shadow-[3px_3px_0_rgba(100,116,139,.18)]" style={{ background: c.accent }} onClick={() => navigate(`/creators/${slugFor(c)}`)} aria-label={`Visit ${c.name}'s page`}>Pop into their shop →</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        ) : search.isPending ? <p className="text-sm font-semibold text-slate-500">Searching the little shops… ✦</p>
          : search.error ? <div className="square bg-white border border-rose-100 p-5" style={{ borderRadius: 0 }}><p className="font-bold text-slate-700">That search hiccuped.</p><p className="text-sm text-slate-500 mt-1">{String(search.error instanceof Error ? search.error.message : search.error)}</p><button className="btn-playful mt-3 px-4 py-2 border border-slate-200 bg-[#34d399] text-white font-bold text-sm" onClick={() => search.refetch()} aria-label="Retry the search">Retry</button></div>
          : results.length === 0 ? (
            <div className="square bg-white border border-amber-100 p-6 text-center shadow-[5px_5px_0_#fef3c7]" style={{ borderRadius: 0 }}>
              <p className="display text-2xl text-slate-700">No shops match that — yet ✿</p>
              <p className="text-sm text-slate-500 mt-2 max-w-md mx-auto">Try a shorter name, fewer categories, or “Any of these” instead of “All”. New creators join with new flavours all the time.</p>
              <button type="button" onClick={clearAll} className="btn-playful mt-4 px-5 py-2.5 bg-[#34d399] text-white font-bold text-sm" aria-label="Clear filters and show every creator">Clear filters — show everyone</button>
            </div>
          ) : (
            <>
              <p className="text-sm font-bold text-slate-600">{results.length} {results.length === 1 ? "creator" : "creators"} found{cats.length > 0 ? ` · categories: ${cats.join(", ")} (${mode === "all" ? "all of these" : "any of these"})` : ""}{debounced.trim() ? ` · matching “${debounced.trim()}”` : ""}</p>
              <div className="mt-3 grid gap-5 md:grid-cols-3">
                {results.map(r => (
                  <article key={r.creatorId} className="square bg-white border border-slate-100 p-1" style={{ boxShadow: `5px 5px 0 ${r.accent}33`, borderRadius: 0 }}>
                    {r.bannerUrl ? <div className="relative h-16 overflow-hidden" style={{ background: r.accent }}><SafeImg src={r.bannerUrl} alt="" className="absolute inset-0 w-full h-full object-cover" /></div> : <div className="h-2.5" style={{ background: r.accent }} />}
                    <div className="p-4">
                      <div className="flex gap-3">
                        <div className="relative w-16 h-16 shrink-0 overflow-hidden flex items-center justify-center text-white display text-2xl" style={{ background: r.accent }}>{r.pfpUrl ? <SafeImg src={r.pfpUrl} alt={`${r.displayName}'s profile picture`} className="absolute inset-0 w-full h-full object-cover" /> : r.displayName.slice(0, 1)}<span className="absolute top-0 right-0 text-amber-400 text-base z-10">★</span></div>
                        <div className="min-w-0 flex-1">
                          <h2 className="display text-[24px] leading-tight truncate text-slate-700">{r.displayName}</h2>
                          <p className="text-[12px] font-semibold text-slate-400">@{r.username}</p>
                          <div className="mt-1 flex flex-wrap gap-1.5">{r.verified && <VerifiedBadge accent={r.accent} />}<span className="pill px-2 py-0.5 text-[10px] font-bold bg-violet-100 text-violet-700">⭐ L{r.level} {r.levelName}</span></div>
                          {r.status !== "open" && <div className="mt-1.5"><span className="pill bg-amber-100 text-amber-700 px-3 py-1 text-[11px] font-bold tilt-r inline-block">◐ Waitlist</span></div>}
                        </div>
                      </div>
                      <p className="mt-3 text-[15px] font-semibold leading-snug text-slate-600">{r.tagline}</p>
                      {r.categories.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{r.categories.map(cat => <span key={cat} className="pill px-2.5 py-1 text-[10px] font-bold border bg-white" style={{ borderColor: `${r.accent}88`, color: "#475569" }}>{cat}</span>)}</div>}
                      <button className="btn-playful mt-4 w-full py-3 font-bold text-[15px] text-white shadow-[3px_3px_0_rgba(100,116,139,.18)]" style={{ background: r.accent }} onClick={() => navigate(`/creators/${r.slug}`)} aria-label={`Visit ${r.displayName}'s page`}>Pop into their shop →</button>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
      </div>
    </section>
  );
}

const REPORT_REASONS = ["Illegal or unsafe content", "Non-consensual or assault material", "Spam or scam", "Copyright — not their work", "Harassment", "Other"] as const;
/** Report control — any visitor can file one (signed in or not). The
    report lands in the owner's Admin queue; nothing is hidden by the
    report itself — the owner decides with Quarantine / Delete / Dismiss. */
function ReportButton({ token, targetType, targetId, itemTitle = "", label = "Report" }: { token: string; targetType: "post" | "creator" | "vault_item" | "portfolio"; targetId: string; itemTitle?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>(REPORT_REASONS[0]);
  const [detail, setDetail] = useState("");
  const [msg, setMsg] = useState("");
  const send = useMutation({ mutationFn: async () => await api.createReport({ token, targetType, targetId, itemTitle, reason: reason as typeof REPORT_REASONS[number], detail: detail.trim() }), onSuccess: () => { setMsg("Reported — thank you. The site owner will review it."); setOpen(false); }, onError: (e) => setMsg(String(e instanceof Error ? e.message : e)) });
  if (msg && !open) return <span className="text-[12px] font-bold text-emerald-600" role="status">{msg}</span>;
  if (!open) return <button type="button" onClick={() => { setOpen(true); setMsg(""); }} className="btn-playful px-3 py-1.5 bg-white border border-amber-200 text-amber-600 text-[11px] font-bold" aria-label={`${label} this content`}>🚩 {label}</button>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2 border border-amber-200 bg-amber-50 px-2 py-2">
      <label className="text-[11px] font-bold text-slate-600">Why?
        <select value={reason} onChange={e => setReason(e.target.value)} className="ml-1 px-2 py-1.5 border border-slate-200 bg-white text-[12px]" aria-label="Report reason">{REPORT_REASONS.map(r => <option key={r} value={r}>{r}</option>)}</select>
      </label>
      <input value={detail} onChange={e => setDetail(e.target.value)} maxLength={500} placeholder="Anything else? (optional)" className="px-2 py-1.5 border border-slate-200 bg-white text-[12px] min-w-[140px]" aria-label="Report details (optional)" />
      <button type="button" disabled={send.isPending} onClick={() => send.mutate()} className="btn-playful px-3 py-1.5 bg-amber-500 text-white text-[11px] font-bold disabled:opacity-50" aria-label="Send this report">{send.isPending ? "Sending…" : "Send report"}</button>
      <button type="button" onClick={() => setOpen(false)} className="btn-playful px-3 py-1.5 bg-white border border-slate-200 text-slate-500 text-[11px] font-bold" aria-label="Cancel this report">Cancel</button>
      {msg && <span className="text-[12px] font-bold text-rose-500" role="alert">{msg}</span>}
    </span>
  );
}

function PostCard({ post, mine, token, isAdmin, onOpenCreator, onPickCategory, onDelete, deleting }: { post: Post; mine: boolean; token: string; isAdmin: boolean; onOpenCreator: (slug: string) => void; onPickCategory: (cat: string) => void; onDelete: (post: Post) => void; deleting: boolean }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const quarantine = useMutation({ mutationFn: async () => await api.adminQuarantine({ token, targetType: "post", targetId: post.id, itemTitle: "", note: "", reportId: "" }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["posts"] }); qc.invalidateQueries({ queryKey: ["state"] }); } });
  return (
    <article className="square bg-white border border-slate-100 p-4 md:p-5" style={{ boxShadow: `5px 5px 0 ${post.accent}2e`, borderRadius: 0 }}>
      <div className="flex items-start gap-3">
        <button type="button" onClick={() => onOpenCreator(post.creatorSlug)} className="relative w-12 h-12 shrink-0 overflow-hidden flex items-center justify-center display text-lg" style={{ background: post.accent, color: onAccent(post.accent) }} aria-label={`Visit ${post.creatorName}'s page`}>
          {post.pfpUrl ? <SafeImg src={post.pfpUrl} alt={`${post.creatorName}'s profile picture`} className="absolute inset-0 w-full h-full object-cover" /> : post.creatorName.slice(0, 1)}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <button type="button" onClick={() => onOpenCreator(post.creatorSlug)} className="display text-lg leading-tight text-slate-700 hover:underline underline-offset-2 text-left" aria-label={`Visit ${post.creatorName}'s page`}>{post.creatorName}</button>
            <button type="button" onClick={() => onOpenCreator(post.creatorSlug)} className="text-[12px] font-bold hover:underline underline-offset-2" style={{ color: accentAsText(post.accent) }} aria-label={`Visit ${post.creatorName}'s page by username`}>@{post.username}</button>
            {post.creatorVerified && <VerifiedBadge accent={post.accent} />}
            <span className="text-[12px] font-semibold text-slate-400 ml-auto shrink-0">{relTime(post.createdAt)}</span>
          </div>
          <h3 className="display text-[22px] leading-snug text-slate-700 mt-1.5">{post.title}</h3>
        </div>
      </div>
      <p className="mt-2 text-[15px] text-slate-600 leading-relaxed whitespace-pre-wrap">{post.body}</p>
      {post.videoUrl && <div className="mt-3 relative border border-slate-200 overflow-hidden bg-black"><video src={post.videoUrl} controls preload="metadata" playsInline className="w-full max-h-80" aria-label={`Video attached to ${post.creatorName}'s post: ${post.title}`} /></div>}
      {post.imageUrl && <div className="mt-3 relative border border-slate-200 overflow-hidden max-h-80"><SafeImg src={post.imageUrl} alt={`Image attached to ${post.creatorName}'s post`} className="w-full max-h-80 object-cover" /></div>}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {post.priceNote && <span className="pill px-3 py-1 text-[11px] font-bold" style={{ background: post.accent, color: onAccent(post.accent) }}>🏷 {post.priceNote}</span>}
        {post.categories.map(cat => <button key={cat} type="button" onClick={() => onPickCategory(cat)} className="pill px-2.5 py-1 text-[10px] font-bold border bg-white hover:bg-emerald-50" style={{ borderColor: `${post.accent}88`, color: "#475569" }} aria-label={`Find creators in ${cat}`}>{cat}</button>)}
        <span className="flex items-center gap-2 flex-wrap">
          <ReportButton token={token} targetType="post" targetId={post.id} />
          {isAdmin && <button type="button" disabled={quarantine.isPending} onClick={() => quarantine.mutate()} className="btn-playful px-3 py-1.5 bg-slate-700 text-white text-[11px] font-bold disabled:opacity-50" aria-label={`Quarantine post ${post.title} (owner)`}>{quarantine.isPending ? "Hiding…" : "🛡 Quarantine"}</button>}
        </span>
        {mine && (
          <span className="ml-auto flex items-center gap-2">
            {confirming ? (
              <>
                <span className="text-[12px] font-bold text-rose-500">Delete this post?</span>
                <button type="button" disabled={deleting} onClick={() => onDelete(post)} className="btn-playful px-3 py-1.5 bg-rose-500 text-white text-[11px] font-bold disabled:opacity-50" aria-label={`Confirm delete of post ${post.title}`}>{deleting ? "Deleting…" : "Yes, delete"}</button>
                <button type="button" onClick={() => setConfirming(false)} className="btn-playful px-3 py-1.5 bg-white border border-slate-200 text-slate-500 text-[11px] font-bold" aria-label="Cancel deleting this post">Keep it</button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirming(true)} className="btn-playful px-3 py-1.5 bg-white border border-rose-200 text-rose-500 text-[11px] font-bold" aria-label={`Delete my post ${post.title}`}>Delete post</button>
            )}
          </span>
        )}
      </div>
    </article>
  );
}

function Home({ account, token, goHow, slugForId }: { account: Account; token: string; goHow: () => void; slugForId: (creatorId: string) => string }) {
  const qc = useQueryClient();
  const feed = useQuery({ queryKey: ["posts"], queryFn: () => api.listPosts({ category: "" }) });
  const del = useMutation({ mutationFn: async (postId: string) => await api.deletePost({ token, postId }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["posts"] }); qc.invalidateQueries({ queryKey: ["myPosts"] }); } });
  const posts = feed.data?.posts ?? [];
  const openCreator = (slug: string) => navigate(`/creators/${slug}`);
  return (
    <div>
      <p className="text-[15px] md:text-base text-slate-600 leading-relaxed max-w-3xl">
        Commission an artist on their own personal page — you pay the artist directly on their own account, in milestones, and the finished artwork stays locked in the Vault until the balance lands. We hold the art, the evidence and the reputation — never your money.{" "}
        <button onClick={goHow} className="font-bold text-sky-600 underline underline-offset-2 whitespace-nowrap" aria-label="Read how it works">How it works →</button>
      </p>
      <div className="mt-5">
        <div className="flex flex-wrap items-end justify-between gap-2 px-1">
          <h1 className="display text-2xl md:text-3xl text-slate-700">Fresh offers from creators ✿</h1>
          {feed.data && <span className="text-sm font-bold text-slate-500" aria-live="polite">{posts.length} {posts.length === 1 ? "offer" : "offers"}</span>}
        </div>
        <div className="mt-4 space-y-4 max-w-3xl" aria-live="polite">
          {feed.isPending ? <p className="text-sm font-semibold text-slate-500 py-6">Gathering the latest offers… ✦</p>
            : feed.error ? (
              <div className="square bg-white border border-rose-100 p-5" style={{ borderRadius: 0 }}>
                <p className="font-bold text-slate-700">The offer board hiccuped.</p>
                <p className="text-sm text-slate-500 mt-1">{String(feed.error instanceof Error ? feed.error.message : feed.error)}</p>
                <button className="btn-playful mt-3 px-4 py-2 border border-slate-200 bg-[#ff6b6b] text-white font-bold text-sm" onClick={() => feed.refetch()} aria-label="Retry loading the offer feed">Retry</button>
              </div>
            ) : posts.length === 0 ? (
              <div className="square bg-white border border-amber-100 p-6 text-center shadow-[5px_5px_0_#fef3c7]" style={{ borderRadius: 0 }}>
                <p className="display text-2xl text-slate-700">No offers yet — the board is brand new ✿</p>
                <p className="text-sm text-slate-500 mt-2 max-w-md mx-auto">When creators post what they're offering, it lands right here. Meanwhile, every creator's page is open for a peek.</p>
                <button type="button" onClick={() => navigate("/search")} className="btn-playful mt-4 px-5 py-2.5 bg-[#ff6b6b] text-white font-bold text-sm" aria-label="Browse creator pages">Meet the creators →</button>
              </div>
            ) : posts.map(p => <PostCard key={p.id} post={p} mine={!!account && account.creatorId === p.creatorId} token={token} isAdmin={!!account?.isAdmin || account?.role === "mod"} onOpenCreator={() => openCreator(slugForId(p.creatorId))} onPickCategory={(c) => navigate(searchPath("", [c], "any", "relevance"))} onDelete={(post) => del.mutate(post.id)} deleting={del.isPending} />)}
          {del.error && <p className="text-sm font-bold text-rose-500" role="alert">{String(del.error instanceof Error ? del.error.message : del.error)}</p>}
        </div>
      </div>
    </div>
  );
}

function HowItWorks({ goCreators }: { goCreators: () => void }) {
  const blocks: { t: string; c: string; bg: string; icon: string; body: React.ReactNode }[] = [
    { t: "Start with a brief", c: "#ff6b6b", bg: "#fff1f2", icon: "brush", body: <p>Every creator has their own page, in their own style, with prices and house rules up front. You send a brief — what you'd like, references, your budget, how many sketch revisions are included — and it lands in their inbox. The artist quotes the job: a total price and a deposit (half is the house suggestion). Nothing is paid until you both agree.</p> },
    { t: "You pay the artist directly", c: "#38bdf8", bg: "#f0f9ff", icon: "coin", body: <p>There is no middleman holding your money — there is no middleman at all. The deposit goes <strong>from you to the artist, on the artist's own payment account</strong> (their Ko-fi, their biller, their e-Transfer — listed on their page). Each artist chooses which payment rails their page offers — external payment links, crypto wallets, or both — and you pick from what they offer when you send your brief. The artist confirms it landed, and only then does work unlock. The platform records the confirmation; it never touches the payment, which is also why it can never refund one — the milestones below are what keep you safe instead.</p> },
    { t: "Or pay by crypto — you send it yourself", c: "#f59e0b", bg: "#fffbeb", icon: "coin", body: <p>Artists can also list a <strong>crypto wallet</strong> (Bitcoin, Litecoin, USDT and friends) right on their page. If you pay that way, <strong>you send the crypto yourself</strong>, from your own wallet to theirs — you need to already hold it, because the site never buys, sells, holds or forwards crypto for anyone, not even for a second. Then you paste the <strong>transaction ID</strong> into the job, and the site's <strong>transaction checker</strong> verifies the payment and releases the next step <strong>automatically</strong>: deposit checked → work unlocks; balance checked → the artwork unlocks. No "trust me, it arrived" taps and no doctored screenshots — the transaction record is the evidence. One honest caveat: crypto payments can't be reversed by anyone, which is exactly why the Vault still holds the artwork until the balance checks out.</p> },
    { t: "Milestones keep every payment small", c: "#f59e0b", bg: "#fffbeb", icon: "star", body: <p>No single payment is ever big enough to be worth stealing. Deposit first, then the <strong>sketch gate</strong>: the artist uploads a sketch, you approve the direction (or spend a revision), and three days of silence counts as approved so artists are never trapped. A standard job targets <strong>7 days</strong> from deposit to delivery. If the artist misses the deadline, you may <strong>walk away</strong> from every remaining milestone — money paid for milestones actually delivered stands, and the job record says so in plain words.</p> },
    { t: "The Vault holds the artwork, not the money", c: "#f472b6", bg: "#fdf2f8", icon: "gift", body: <p>The finished piece is delivered into the platform's <strong>Vault</strong>. You see a watermarked, downscaled preview — enough to know it's right, never enough to take. You pay the balance directly to the artist; they confirm; the original <strong>unlocks</strong> and every download is logged. The classic scam — receive the art, refuse to pay — has nothing to grab. And if an artist is paid in full and then vanishes, the platform can release the already-delivered file after 7 days: what it releases is art, not money.</p> },
    { t: "Reputation is the bond", c: "#a78bfa", bg: "#f5f3ff", icon: "shield", body: <p>Both sides earn <strong>standing</strong> for jobs done well — a game-like score that is earned only: never purchasable, never transferable, no cash value. Standing sets your level, and levels unlock bigger quotes and the Weekly Vault. Verified members (ID checked by a person, not stored as documents here) carry a badge, and artists can choose verified buyers only. Walking off without paying, or without delivering, is a ban-tier offence — and a ban attaches to the verified person and <strong>burns their standing</strong>, so scamming costs everything they built.</p> },
    { t: "If something goes wrong", c: "#34d399", bg: "#ecfdf5", icon: "heart", body: <p>Every brief, quote, confirmation, sketch and delivery lives in one job record — the evidence. If a dispute opens, the owner judges from that record. Refunds of direct payments are <strong>the seller's own obligation</strong>: a seller who owes a refund and doesn't pay it carries the amount as a <strong>refund balance</strong> — their new commissions and quotes pause until it's settled — and a seller who simply vanishes faces a person-ban. And for the clearest cases there's the <strong>Trust Pool</strong>: when a scam is provable from the job record itself (deadline passed, nothing delivered), the pool pays the buyer <strong>instantly</strong> out of the platform's own funds, and the amount becomes the scammer's refund balance. An accusation alone never pays — the record has to prove it. An artist whose balance goes unpaid for 7 days after Vault delivery can escalate to the owner, withdraw the file, or route it to the Weekly Vault salvage door.</p> },
    { t: "How the site itself is paid for", c: "#fb923c", bg: "#fff7ed", icon: "star", body: <p>Not with a cut of your payments — on the crypto rail there's no moment where a cut could even be taken, and on direct payments the money never passes through the site at all. The plan is <strong>seller subscriptions and donations</strong> instead: the subscription price isn't set yet (it gets decided once there are sellers to ask), and nobody's commission money is ever skimmed to fund the site. A payment system of the site's own is a later step, once there's a clientele — for now, sellers bring their own ways to get paid and the site choreographs.</p> },
  ];
  return (
    <section>
      <div className="bg-sky-50 px-5 py-6 border border-sky-100">
        <h1 className="display text-4xl leading-tight text-slate-700">How it works ✿</h1>
        <p className="text-slate-500 mt-2 max-w-2xl">The short version: you commission an artist, you pay them directly (their payment links, or crypto you send yourself), and the finished artwork waits in the Vault until the balance lands — then it unlocks. Here's the slightly longer version — take what you need, skip the rest.</p>
      </div>
      <div className="mt-6 space-y-5 max-w-3xl">
        {blocks.map((b, i) => (
          <div key={b.t} className="square bg-white border border-slate-100 overflow-hidden" style={{ boxShadow: `5px 5px 0 ${b.c}2e`, borderRadius: 0 }}>
            <div className="px-5 py-3 flex items-center gap-2" style={{ background: b.bg }}>
              <span className="pill w-7 h-7 inline-flex items-center justify-center text-white text-[13px] font-bold shrink-0" style={{ background: b.c }}>{i + 1}</span>
              <span style={{ color: b.c }}><Icon name={b.icon} className="w-5 h-5" /></span>
              <h2 className="display text-[22px] text-slate-700">{b.t}</h2>
            </div>
            <div className="p-5 text-[15px] text-slate-500 leading-relaxed">{b.body}</div>
          </div>
        ))}
      </div>
      <div className="mt-8 flex flex-wrap items-center gap-4">
        <button onClick={goCreators} className="btn-playful px-7 py-3.5 bg-[#ff6b6b] text-white font-bold text-base shadow-[4px_4px_0_#fde047]" aria-label="Browse creator pages">Meet the creators →</button>
        <Speech color="#fef9c3">That's the whole trick — no fine print hiding underneath. ♥</Speech>
      </div>
    </section>
  );
}

function TermsPage() {
  const clauses: { t: string; body: React.ReactNode }[] = [
    { t: "1. Beta status — simulated credits only", body: <><p>This site is currently a <strong>closed, invite-only beta</strong>. Every dollar figure is a simulated credit. Simulated credits <strong>have no monetary value</strong>: they cannot be purchased, cannot be transferred to another person, cannot be redeemed for money, goods or services, and may be reset or wiped at any time — including at the end of the beta. Nothing in these terms creates a real-money obligation while the beta notice is showing.</p><p className="mt-2"><strong>Beta note:</strong> joining the beta is invitation-only. Features and prices are simulated, but the content rules, the 18+ rule and the privacy rules below are the real ones — testers are not exempt from them. We may use feedback you give us to improve the site, and beta data will be deleted by the date stated in the tester information sheet.</p></> },
    { t: "2. Who can use it — 18+ and ID verification", body: <p>The site is for people <strong>18 or older</strong> only — buyers, creators, and anyone browsing public pages. You confirm your age at sign-up, and the operator may require identity verification at any time and suspend an account until it is provided. <strong>Creators must complete government photo-ID verification before listing or uploading anything</strong>, and every person depicted in uploaded content must be an adult whose identity has been verified and who has given written consent (see clause 8). Accounts are personal and non-transferable, and anyone previously banned may not open a new one. A bare "I am 18" checkbox is not enough for creators or depicted persons — card-network rules for adult content require real ID checks, and these terms adopt that standard.</p> },
    { t: "3. Accounts & your page", body: <p>You're responsible for accurate registration information, for keeping your password secure, and for activity under your account (subject to consumer law). Creator pages are public storefronts; you may decorate yours with your own images and colours through the built-in customizer. Uploaded media must be yours, or work you have the rights to use, and must not contain private information about other people. Keep payout and tax information current. The platform may remove content or pages that break these terms.</p> },
    { t: "4. The platform's role — intermediary, not a party", body: <p>The commission contract is <strong>directly between the buyer and the creator</strong>. The platform provides the storefronts, messaging, payment-handling mechanics and the dispute process in clause 6; it is <strong>not a party to the commission contract</strong>, is not the creator's employer or agent, and does not produce or supervise the work — its quality, legality and delivery are the creator's responsibility, not the platform's. Creators are independent contractors. To be plain about the balance: the platform <em>does</em> operate the hold-and-release mechanics and the dispute process, and it keeps its own legal duties (privacy, content reporting, consumer law for its own service) — this clause allocates roles, it does not erase those duties.</p> },
    { t: "5. How payment works — who holds the money", body: <><p>In the live version, <strong>payment is held by the payment processor</strong> (an adult-specialist biller) pending delivery and acceptance, and is released in accordance with these terms. Money for a commission <strong>never enters a bank account the platform owns or controls</strong>; the platform's role is limited to supplying the processor with amounts, identities and fee splits. Step by step:</p><p className="mt-2"><strong>Authorize, then capture.</strong> When a job is accepted, the buyer's card is authorized — a temporary hold, not yet a charge. Authorization holds expire (commonly after about 7 days), so capture timing follows what the processor's rails actually support; these terms do not promise a hold the processor cannot make. <strong>Longer jobs</strong> are captured into a processor-held subaccount for that job instead.</p><p className="mt-2"><strong>Release happens when:</strong> the buyer accepts the delivery; or the 7-day review window after delivery passes with no dispute (that silence is <strong>deemed acceptance</strong> — see clause 6); or a dispute decision says so.</p><p className="mt-2"><strong>Weekly blocks.</strong> Jobs longer than 7 days are split into weekly blocks of at most <strong>$50 per week</strong>. Each block is a defined deliverable with its own delivery and acceptance — an undifferentiated "weekly release" is not how this works.</p><p className="mt-2"><strong>Chargebacks.</strong> Card-network chargeback rights exist regardless of these terms. A chargeback can reverse a payment already released to a creator, and the creator's balance may be adjusted for it during the processor's clawback window.</p><p className="mt-2"><strong>What held money is not.</strong> A held balance is <strong>not a bank deposit, earns no interest, and carries no CDIC deposit insurance coverage</strong>. Held funds are never used by the platform for anything else.</p></> },
    { t: "6. Delivery, acceptance, refunds & disputes", body: <><p>A commission starts with a written brief. The creator may accept, decline, or counter the price; no job exists until both sides agree. Before the final piece, the creator submits a sketch (or outline/reel equivalent) for the buyer's approval — approving it locks the direction. Each job includes the stated number of revisions for fine-tuning; work beyond the brief is a new commission, not a revision.</p><p className="mt-2"><strong>Standard jobs:</strong> the creator has <strong>7 days</strong> to deliver. Delivery means uploading the work through the platform. The buyer then has <strong>7 days from delivery</strong> to accept or raise a dispute; if the window passes after reminder notices with no dispute, the delivery is <strong>deemed accepted</strong> and payment is released.</p><p className="mt-2"><strong>Non-delivery:</strong> if the creator misses the agreed deadline (plus any grace period stated in the job), the buyer may cancel and receive a <strong>full refund of all amounts held and not yet released</strong>. On weekly-block jobs, blocks already released for delivered work stay released; unreleased blocks are refunded. Work that matches the brief and the approved sketch but isn't to the buyer's taste is handled through revisions, not refunds.</p><p className="mt-2"><strong>Disputes:</strong> either side may open one within the acceptance window. The platform reviews the brief, the delivered files and the job thread, and may decide release, refund, or a split. That decision is <strong>final as to the release of the held funds only</strong> — it does not remove anyone's statutory or court rights. Checkout shows the total price, the platform fee, the delivery date and these refund rules <em>before</em> the buyer commits, and a copy of the contract follows within 15 days, as Alberta's Internet Sales Contract Regulation requires. <strong>Nothing in these terms waives rights under Alberta's Consumer Protection Act, or the consumer-protection law of the buyer's home province — those rights cannot be signed away.</strong></p></> },
    { t: "7. Fees", body: <p>The platform's service fee — its percentage and who bears it — is <strong>shown before any money moves</strong>, calculated on the commission price, with GST/HST treatment stated. The fee is <strong>earned on release</strong>. If a job is refunded for non-delivery, the platform fee on the refunded amount is refunded too — the platform does not keep a fee on money that went back. Processor, payout or chargeback fees are passed through only where shown. Payout schedule, minimums and currency are the processor's and are stated on the payout page. Fee changes apply prospectively, with notice, and never retroactively to in-flight commissions. In this beta all fees are simulated (10% in the demo numbers).</p> },
    { t: "8. Content rules & review", body: <><p>Prohibited, without exception:</p><ul className="mt-2 space-y-1.5 list-none"><li>▸ <strong>Any sexual content involving anyone under 18, in any form.</strong> Canada's definition is broader than most people expect: it covers people <em>depicted as</em> under 18, fictional, drawn or AI-generated characters presented as minors, and erotic writing or audio about minors. All of it is banned here, absolutely.</li><li>▸ Non-consensual intimate imagery, including AI-generated fakes of a real person.</li><li>▸ Content without the documented consent of every person depicted.</li><li>▸ Obscene content under Canadian law, and content offering or arranging in-person sexual services or meet-ups — this is a marketplace for creative work only.</li><li>▸ Content that infringes someone else's copyright or trademark, and anyone else's private personal information.</li></ul><p className="mt-2">Uploads are <strong>reviewed before they are published</strong>. The platform may remove content, and may hold associated payouts pending review. If content appears to be child sexual abuse material, access is disabled immediately, the data is preserved, and the operator reports it to <strong>Cybertip.ca</strong> and notifies police, as Canada's mandatory reporting law requires — that duty applies from the very first upload, beta included. A public report route (no login needed) exists for illegal or non-consensual content, with complaints about such content reviewed and resolved within 7 business days.</p></> },
    { t: "9. Copyright & licences — payment is not ownership", body: <><p>Under Canada's Copyright Act, <strong>the creator (the author) is the first owner of copyright</strong> in their work. Paying for a commission does <strong>not</strong> transfer copyright — a transfer requires a signed written assignment, and moral rights can only be waived in writing, never assigned. So this site works in licences:</p><ul className="mt-2 space-y-1.5 list-none"><li>▸ <strong>Platform licence:</strong> by uploading, you give the platform a non-exclusive licence to host, store, copy, transcode and display your content <em>as you direct through the service</em> — public samples publicly, private deliverables only to the commissioning buyer. The platform gets <strong>no right to use private commissioned deliverables in its own advertising</strong>.</li><li>▸ <strong>Buyer licence:</strong> each commission grants the buyer a <strong>personal, non-commercial licence</strong> to use the delivered work by default. Commercial use, merchandise, redistribution or AI-training use applies only where that licence was expressly bought in the commission agreement.</li><li>▸ <strong>Resale:</strong> the platform acquires <strong>no right to resell or auction delivered or rejected work</strong> from these terms — none. Rejected work stays the creator's, in full. A resale can happen only under a <strong>separate, express, opt-in agreement</strong> signed by the creator for that work (see clause 10). Buyers likewise may not resell or mint delivered work beyond their licence.</li></ul><p className="mt-2">Creators warrant that they own or have the rights to what they upload, and that every depicted person is an adult with documented consent. A repeat-infringer termination policy applies; the copyright complaint process runs on the page's report route (Canada's notice-and-notice system, and a DMCA track for US notices).</p></> },
    { t: "10. The Weekly Vault", body: <p>Creators may submit up to <strong>10 pictures and 10 videos per week</strong> to the weekly bundle, through two doors: <strong>Fresh</strong> (new work) and <strong>Salvage</strong> (earlier work). Submitting an entry is an <strong>opt-in for that work only</strong>: it grants the platform a licence to include that entry in that week's bundle sale, nothing more. Salvage is eligible only where the creator holds full resale rights — no buyer likeness, no private references, no exclusively-sold characters — and, for work that began as a commission, only under the separate opt-in agreement described in clause 9. The winning bid is split by shares — <strong>picture = 1 share, video = 3 shares</strong> — after the platform fee. A buyer who was fully refunded for a job receives nothing from its salvage.</p> },
    { t: "11. Termination & held funds", body: <p>The platform may suspend or terminate an account for breaking these terms, illegal content, chargeback abuse, or failed verification. What happens to money is fixed and does not depend on why the account ended: <strong>amounts held for undelivered work are refunded to the buyer; payment for work delivered and accepted is released to the creator</strong>. Earned balances are not forfeited for ordinary rule-breaking. Where fraud or illegal content is involved, held funds are handled as the payment processor and law enforcement direct. You may close your account once in-flight commissions are complete. The IP licences for delivered work, the fee, liability and dispute clauses survive termination.</p> },
    { t: "12. Liability, governing law & the honest label", body: <><p>To the maximum extent permitted by law, the platform's liability is capped at the greater of the fees you paid the platform in the preceding 12 months or CAD $100, and indirect or consequential damages are excluded. The cap <strong>never applies to amounts held for you awaiting release or refund</strong> — that is your money, not damages. Nothing here excludes liability that cannot legally be excluded, or any non-waivable consumer right.</p><p className="mt-2">These terms are governed by the laws of <strong>Alberta</strong> and the federal laws of Canada, and Alberta courts are the forum — <strong>subject to the mandatory consumer-protection law of your province of residence</strong>. No clause here forces a consumer into arbitration or waives class-action rights where the law prohibits that. Material changes — especially to fees or release rules — are announced in advance and never applied retroactively to in-flight commissions.</p><p className="mt-2"><strong>The honest label:</strong> these terms are a <strong>research-based draft template</strong>, rebuilt from primary Canadian sources in November 2026. They are <strong>not legal advice</strong> and have not been reviewed by a lawyer. Before a public launch, and again before any real money moves, the operator must have the terms, the privacy policy and the payment flow reviewed by qualified Alberta professionals — privacy, payments and adult content are three different specialisms.</p></> },
  ];
  const stages: { t: string; color: string; items: string[] }[] = [
    { t: "Stage A — MUST before the closed 5-person beta (simulated money)", color: "#34d399", items: ["File a Declaration of Trade Name if operating under the brand name (Alberta registry agent); keep business banking and records separate from personal from day one.", "Publish Beta Terms with clickwrap acceptance at sign-up; 18+ eligibility and age confirmation; simulated credits drafted as valueless — not purchasable, transferable or redeemable, with a wipe notice.", "Publish a privacy policy meeting Alberta PIPA (and PIPEDA), including a named privacy contact and the outside-Canada service-provider table PIPA s.13.1 requires (see the privacy section above).", "ID-verify creator testers (government ID, via a vendor or a documented manual check); depicted-person consent form live and actually used for any multi-person content.", "Content Policy live; a human reviews every upload before publication; the child-safety playbook written down before the first upload: disable access, preserve the data, report to Cybertip.ca, notify police, never tip off the uploader, log every step.", "Copyright policy (Canada's notice-and-notice track) and a report-content contact live.", "Email set up to satisfy CASL: receipts and job notices carry no promotions; marketing only to people who expressly opted in; sender identification and a working unsubscribe in every message.", "Security baseline: encryption, two-factor authentication on admin and creator accounts, restricted access to ID and consent records, and a breach playbook covering both privacy regulators.", "Tester information/consent sheet: what data is collected, that a human reviews content, how long beta data is kept — and a beta-end deletion date that is actually honoured."] },
    { t: "Stage B — MUST before public launch (processor-held funds)", color: "#38bdf8", items: ["Decide incorporation with advice before public contracts and fees flow — a sole proprietor carries unlimited personal liability for a public adult marketplace.", "Full public Terms (all the load-bearing clauses above), Privacy Policy, Content Policy and a two-track Copyright Policy — Canada notice-and-notice and, if serving the US, a DMCA track with a registered US copyright agent.", "Contract with an adult-specialist payment biller (CCBill/Segpay class) structured end-to-end processor-held: funds never enter an account the platform owns or controls, the platform supplies data only — get the flow in writing. This structure is what keeps the platform outside Bank of Canada payment-service-provider status under its December 2025 marketplace policy. Mainstream processors (Stripe/PayPal) prohibit this category outright.", "Obtain and file a documented FINTRAC analysis for that flow (a FINTRAC interpretation request or a payments-law opinion). FINTRAC has published no marketplace policy equivalent to the Bank of Canada's, so whether a processor-held marketplace still counts as remitting funds is genuinely unsettled — the documented analysis is the defence.", "Implement the card-brand adult rules in full (Mastercard AN 5196 / Visa VIRP): vendor ID verification for uploaders and every depicted person, written consent covering depiction, distribution and download, review of all content before publication, a public complaint process resolved within 7 business days, a depicted-person removal route, an anti-trafficking policy, monthly reporting to the acquirer.", "Non-consensual intimate image process with a 48-hour removal target (the US TAKE IT DOWN Act standard) and immediate disabling while under review.", "Age assurance for viewing explicit content via a privacy-preserving third-party method (minimal data, method choice, an appeal route); monitor Bill S-209 — passed the Senate in April 2026, in House committee at research time, not yet law.", "Checkout rebuilt as the Alberta Internet Sales Contract disclosure point: total price and fee, delivery date, acceptance and refund rules before commitment; contract copy sent within 15 days; refunds within 15 days of a valid cancellation.", "Make the Quebec decision: either Law 25 compliance (French-language policy, tracking technologies off by default, a privacy impact assessment before data leaves Quebec, an incident register) or geo-exclusion of Quebec. There is no small-seller exception.", "Cookie posture: strictly-necessary cookies by default, opt-in consent for analytics or marketing trackers, and no third-party ad trackers in account or commission areas — on an adult site, browsing behaviour is sensitive personal information.", "Moderation records and a written retention schedule running; a public report-content surface that needs no login. GST/HST registration once the $30,000 small-supplier threshold is met or near. A WCAG 2.2 AA pass on sign-up, age-gate, checkout and report flows."] },
    { t: "Stage C — MUST before real money at scale, or before the platform ever holds funds itself", color: "#f472b6", items: ["Scaling on the processor-held model: re-verify the flow still qualifies as end-to-end at the new volume — no platform-controlled settlement, reserve or payout accounts quietly introduced by 'optimizations'. Scale moderation and consent records with volume; run periodic card-brand self-audits; watch chargeback ratios.", "Assess CRA digital-platform seller reporting, and US tax and state age-verification coverage as the US share grows.", "Before ANY direct holding of funds: FINTRAC money-services-business registration BEFORE operating, plus a full AML programme — compliance officer, risk assessment, identity verification, transaction reporting, 5-year records. Registration cannot be backdated.", "Before ANY direct holding: Bank of Canada registration under the Retail Payment Activities Act BEFORE performing payment activities, plus the safeguarding framework — segregated accounts at a prudentially regulated financial institution, a per-user ledger, incident reporting, annual reporting. Allow months for the application queue.", "Provincial check in writing before direct holding: confirmation from Service Alberta on designated-business status for this model (no general Alberta licence for online marketplaces was found in the research — a negative finding, not proof), and a Revenu Québec money-services licence if Quebec is served.", "Rewrite the Terms' payment clause for the new custody reality BEFORE the flow changes — the words must always match who actually holds the money."] },
  ];
  return (
    <section>
      <div className="bg-violet-50 px-5 py-6 border border-violet-100">
        <h1 className="display text-4xl leading-tight text-slate-700">Terms &amp; the road to real ✿</h1>
        <p className="text-slate-500 mt-2 max-w-2xl">Three things live on this page: the <strong>Terms &amp; Conditions draft</strong> (what buyers and creators agree to), a <strong>privacy section</strong> in plain words, and the <strong>operator's launch checklist</strong> — the regulatory side of running a site like this, staged from a closed 5-person test to real money. The draft was rebuilt from a sourced regulatory research report for an Alberta, Canada operator (researched 2026-11-13, primary sources: Bank of Canada, Parliament, federal and Alberta privacy regulators). Honest label: this is a research-based template, <strong>not legal advice</strong>.</p>
      </div>
      <div className="mt-6">
        <SectionBar color="#a78bfa">Terms &amp; Conditions — research-based draft</SectionBar>
        <div className="mt-3 space-y-4 max-w-3xl">
          {clauses.map(cl => (
            <div key={cl.t} className="square bg-white border border-slate-100 p-5" style={{ boxShadow: "5px 5px 0 #ede9fe", borderRadius: 0 }}>
              <h2 className="display text-xl text-slate-700">{cl.t}</h2>
              <div className="mt-2 text-[15px] text-slate-500 leading-relaxed">{cl.body}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-8">
        <SectionBar color="#34d399">Model v2 addendum — direct payments, milestones &amp; standing</SectionBar>
        <Speech color="#ecfdf5">This addendum states the current (v2) model and wins wherever it differs from the earlier processor-held draft above: the platform holds the artwork, the evidence and the reputation — never the money.</Speech>
        <div className="mt-3 space-y-4 max-w-3xl">
          <div className="square bg-white border border-slate-100 p-5" style={{ boxShadow: "5px 5px 0 #d1fae5", borderRadius: 0 }}>
            <h2 className="display text-xl text-slate-700">A. Direct payments — the platform never holds payments</h2>
            <div className="mt-2 text-[15px] text-slate-500 leading-relaxed">
              <p>Commission payments are made <strong>directly between the buyer and the creator</strong>, through the creator's own payment account or service. The platform is never the merchant, never receives, holds or transmits commission funds, and supplies only the choreography: brief, quote, deposit confirmation, sketch gate, Vault delivery, balance confirmation and unlock. <strong>Because the platform never holds payments, it cannot refund payments made directly between users.</strong> A party seeking a refund of a direct payment must pursue it with the other party and their payment provider; the platform's remedies are the enforcement measures in clause C.</p>
              <p className="mt-2"><strong>Milestones &amp; walk-away.</strong> A job runs Brief → Quote → Deposit → Sketch approval → Vault delivery → Balance → Unlock. No work is owed before the creator confirms the deposit. If the creator misses the agreed delivery deadline, the buyer may walk away from all <em>remaining</em> milestones; amounts already paid directly for milestones actually delivered are not repayable through the platform. If the buyer stays silent at the sketch gate for 3 days, approval is deemed given. If the balance is unpaid 7 days after Vault delivery, the creator may escalate to the operator, withdraw the Vault file, or — where they hold resale rights — route it to Weekly Vault salvage.</p>
              <p className="mt-2"><strong>Ghost-delivery licence.</strong> By delivering a finished piece to the Vault, the creator grants the platform a limited licence: if the balance has been confirmed paid and the artist takes no unlock action within 7 days — or the unlocked file sits unclaimed for 7 days — the platform may release (or record as released) the already-delivered Vault file to the commissioning buyer. The licence covers that delivery only; it grants no other rights in the work.</p>
            </div>
          </div>
          <div className="square bg-white border border-slate-100 p-5" style={{ boxShadow: "5px 5px 0 #d1fae5", borderRadius: 0 }}>
            <h2 className="display text-xl text-slate-700">B. Standing — a scoreboard, not a currency</h2>
            <div className="mt-2 text-[15px] text-slate-500 leading-relaxed">
              <p>Standing points are a revocable licence and a reputation record only. They are <strong>earned solely through platform behaviour</strong> (completed jobs, on-time delivery, clean approvals, verification), are <strong>not purchasable, not transferable between users, and not redeemable</strong> for money, goods or services, and have <strong>no cash value</strong>. Standing may be spent only on platform-issued perks (cosmetics and allowances). Levels derived from lifetime standing gate quote sizes and Weekly Vault access. On a ban, the account's standing balance and lifetime earned are burned (zeroed); that consequence is part of these terms.</p>
            </div>
          </div>
          <div className="square bg-white border border-slate-100 p-5" style={{ boxShadow: "5px 5px 0 #d1fae5", borderRadius: 0 }}>
            <h2 className="display text-xl text-slate-700">C. Verification, strikes &amp; bans</h2>
            <div className="mt-2 text-[15px] text-slate-500 leading-relaxed">
              <p>Verified status is granted after an identity check performed by the operator or a verification service; the platform stores the verified flag, the date and the service reference — not document images. Enforcement runs warning → strike → restriction → person-ban, judged from the job record. Non-payment after delivery, non-delivery after a confirmed deposit, and chargeback-after-unlock are ban-tier offences. Device/network signals may be used as <strong>tripwires</strong> that flag a possible ban-evasion account for human review; they never ban anyone automatically.</p>
            </div>
          </div>
<div className="square bg-white border border-slate-100 p-5" style={{ boxShadow: "5px 5px 0 #d1fae5", borderRadius: 0 }}>
            <h2 className="display text-xl text-slate-700">D. Crypto rail, refund balances &amp; the Trust Pool (2026-11-14)</h2>
            <div className="mt-2 text-[15px] text-slate-500 leading-relaxed">
              <p><strong>Crypto, send-it-yourself.</strong> A creator may list public crypto receive addresses alongside external payment links, and chooses which rails their page offers. On a crypto job, the buyer must already hold the crypto and sends it <strong>themselves, wallet to wallet</strong>; the buyer then submits the transaction ID and the platform's transaction checker verifies the payment and releases the next step automatically (deposit → work unlocks; balance → artwork unlocks). <strong>The platform never buys, sells, holds, forwards or converts crypto or any other value for any user, for any duration</strong>, and never holds private keys — only public addresses are ever listed. In the closed beta the checker is simulated (it validates the transaction ID against the job record); live on-chain verification arrives with hosting, and the beta label says so wherever the checker runs. Crypto payments are irreversible by design; the milestone and Vault mechanics are the protection on this rail, and the chargeback-after-unlock case does not exist on it.</p>
              <p className="mt-2"><strong>Refund balances.</strong> Refunds of direct payments (external or crypto) are the <strong>seller's own obligation</strong>, because the platform never held the payment. A seller who owes a refund and does not pay it carries the amount as a <strong>refund balance</strong> on their account: while it stands, they cannot take new commissions or quote new jobs. A seller who abandons the obligation entirely is subject to a person-ban under clause C. The platform cannot debit a seller's external accounts or wallets — the balance locks the door, it does not reach through it.</p>
              <p className="mt-2"><strong>Trust Pool.</strong> The operator maintains a pool of the platform's <strong>own funds</strong>. When a scam is provable from a job's own record (for example: deadline passed, deposit confirmed, nothing delivered), the operator may pay the affected buyer from the pool without a claims process, and the paid amount becomes the responsible seller's refund balance. The pool is a <strong>goodwill policy of the operator</strong>: it is not insurance, not a deposit scheme, and not a promise that any particular loss will be covered; coverage is decided from the job record, and an accusation without record proof does not pay.</p>
              <p className="mt-2"><strong>How the platform earns.</strong> The platform's revenue model is <strong>seller subscriptions and voluntary donations</strong> (subscription pricing is not yet set). No percentage is taken from wallet-to-wallet crypto payments — there is no point in that flow where the platform could take one — and direct external payments never pass through the platform. A platform-operated payment system is a possible later step, gated on the Stage B/C checklist above, not a current feature.</p>
              <p className="mt-2"><strong>Roles.</strong> The operator's account is the <strong>dev account</strong>. The dev may appoint <strong>moderator</strong> accounts, which can work the reports queue, quarantine, strikes and bans; invite codes, role appointments, refund balances, Trust Pool covers, verification and standing grants remain dev-only. Every staff action is written to the moderation log.</p>
            </div>
          </div>
                  </div>
      </div>
      <div className="mt-8">
        <SectionBar color="#38bdf8">Privacy — in plain words</SectionBar>
        <div className="mt-3 space-y-4 max-w-3xl">
          <div className="square bg-white border border-slate-100 p-5" style={{ boxShadow: "5px 5px 0 #dbeafe", borderRadius: 0 }}>
            <h2 className="display text-xl text-slate-700">Which laws apply — both of them</h2>
            <div className="mt-2 text-[15px] text-slate-500 leading-relaxed">
              <p>This site is operated from Alberta, and <strong>two privacy laws apply at once</strong>: Alberta's <strong>Personal Information Protection Act (PIPA)</strong> governs personal information handled within Alberta, and Canada's <strong>PIPEDA</strong> applies to personal information that crosses provincial or national borders in commercial activity — which an online marketplace's traffic does by default. Being a sole proprietor, or being small, is not an exemption under either law. If Quebec residents are allowed to sign up at public launch, Quebec's stricter Law 25 applies to their information too (see the Stage B checklist).</p>
              <p className="mt-2">The operator is the privacy officer for this site. Questions, access requests and correction requests go to the operator directly; complaints can also go to the Office of the Information and Privacy Commissioner of Alberta or the Privacy Commissioner of Canada.</p>
            </div>
          </div>
          <div className="square bg-white border border-slate-100 p-5" style={{ boxShadow: "5px 5px 0 #dbeafe", borderRadius: 0 }}>
            <h2 className="display text-xl text-slate-700">What is collected, and why</h2>
            <div className="mt-2 text-[15px] text-slate-500 leading-relaxed">
              <p>Account details (display name, username, email, a salted one-way password hash — never the password itself), page customization, posts, and commission/ledger records — collected to run accounts, pages and jobs. Session tokens are stored only as hashes. The site runs <strong>no ads and no third-party trackers</strong>, and personal information is never sold. In the live version, identity-verification documents and depicted-person consent records are also collected for the safety and card-network reasons in clauses 2 and 8; that kind of sensitive information requires your <strong>express consent</strong>, asked for separately — it is never bundled into accepting the terms. Information is kept only as long as the purpose (or a legal duty, such as tax or copyright record-keeping) requires, then destroyed or anonymized. You may ask what information the site holds about you and ask for corrections; PIPEDA sets a 30-day response clock and PIPA a 45-day one.</p>
              <p className="mt-2">If a breach puts anyone at real risk of significant harm — on an adult site, a leak of identity documents, intimate content or payment details plainly qualifies — the operator reports it to the Alberta Commissioner without unreasonable delay under PIPA, reports to the federal Privacy Commissioner and notifies affected people under PIPEDA, and keeps a record of every breach.</p>
            </div>
          </div>
          <div className="square bg-white border border-slate-100 p-5" style={{ boxShadow: "5px 5px 0 #dbeafe", borderRadius: 0 }}>
            <h2 className="display text-xl text-slate-700">Service providers outside Canada (PIPA s.13.1)</h2>
            <div className="mt-2 text-[15px] text-slate-500 leading-relaxed">
              <p>Alberta's PIPA allows personal information to be handled by service providers outside Canada, but it requires the operator to say <strong>where</strong> and <strong>why</strong> — so here it is, in the form s.13.1 expects. The operator remains accountable for information handed to a provider, and provider contracts must require comparable safeguards, limited use, and prompt breach notice.</p>
              <ul className="mt-2 space-y-2 list-none">
                <li>▸ <strong>Hosting &amp; infrastructure</strong> — servers may be located in the <strong>United States</strong> and other countries the host operates in — used to run the site and store uploads and account data.</li>
                <li>▸ <strong>Identity verification</strong> (live version) — a specialist vendor, expected to be US-based — used only to return a verification result; ID images are stored with the vendor or encrypted with restricted access, never in general site storage.</li>
                <li>▸ <strong>Payment processing</strong> (live version) — the adult-specialist biller — used to hold and move commission funds and run payouts; the biller's own country list applies to payment data.</li>
                <li>▸ <strong>Email delivery</strong> — transactional mail provider, may process in the US — used for receipts, delivery notices and security alerts only.</li>
              </ul>
              <p className="mt-2">Information processed in another country may be accessible to that country's courts and law enforcement. To read the operator's full policies on outside-Canada service providers, or to ask questions about them, contact the privacy officer (the operator) through the site's contact route — PIPA s.13.1 gives you that right, and this section is the notice it requires.</p>
            </div>
          </div>
        </div>
      </div>
      <div className="mt-8">
        <SectionBar color="#f472b6">Before real users &amp; real money — operator checklist</SectionBar>
        <Speech color="#fef9c3">Staged from the 2026-11-13 research report (§7). Laws, bills and processor rules move — S-209 was still in committee at research time — so re-check each item, with a lawyer where it says so, before acting on it. ♥</Speech>
        <div className="mt-3 space-y-4 max-w-3xl">
          {stages.map(s => (
            <div key={s.t} className="square bg-white border border-slate-100 p-5" style={{ boxShadow: `5px 5px 0 ${s.color}33`, borderRadius: 0 }}>
              <h2 className="display text-xl text-slate-700">{s.t}</h2>
              <ul className="mt-2 space-y-2 text-[15px] text-slate-500 leading-relaxed list-none">
                {s.items.map(it => <li key={it.slice(0, 32)} className="flex gap-2"><span style={{ color: s.color }} aria-hidden="true">▸</span><span>{it}</span></li>)}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-5 text-sm text-slate-500 max-w-3xl">The Reddit-recruited 5-seller test fits Stage A exactly: simulated money, invite-only, honest labels. A fake-money beta steps around the payment regimes — and almost nothing else: privacy, child-safety reporting, copyright, spam law and these terms all apply from the first tester and the first upload. The moment a real dollar is involved — even one — the Stage B structure (an adult-specialist biller holding funds end-to-end, the platform supplying data only) is what keeps the platform outside the heaviest money regulation, and Stage C's registrations are the gate if that ever changes.</p>
      </div>
    </section>
  );
}

type AdminState = ApiResponse<typeof api, "adminGetState">;
function AdminPage({ token, isDev }: { token: string; isDev: boolean }) {
  const qc = useQueryClient();
  const admin = useQuery({ queryKey: ["adminState", token], queryFn: () => api.adminGetState({ token }) });
  const [maxUses, setMaxUses] = useState(5);
  const [lastCode, setLastCode] = useState("");
  const [msg, setMsg] = useState("");
  const [grantAmt, setGrantAmt] = useState<Record<string, number>>({});
  const [strikeNote, setStrikeNote] = useState<Record<string, string>>({});
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const invalidate = () => { qc.invalidateQueries({ queryKey: ["adminState"] }); qc.invalidateQueries({ queryKey: ["state"] }); qc.invalidateQueries({ queryKey: ["posts"] }); qc.invalidateQueries({ queryKey: ["session"] }); };
  const fail = (e: unknown) => setMsg(String(e instanceof Error ? e.message : e));
  const gen = useMutation({ mutationFn: async () => await api.adminGenerateInvite({ token, maxUses }), onSuccess: (r) => { setLastCode(r.code); setMsg(`Invite code created: ${r.code}`); invalidate(); }, onError: fail });
  const disableInv = useMutation({ mutationFn: async (id: string) => await api.adminDisableInvite({ token, inviteId: id }), onSuccess: invalidate, onError: fail });
  const quar = useMutation({ mutationFn: async (v: { targetType: "post" | "creator" | "vault_item" | "portfolio"; targetId: string; itemTitle?: string; reportId?: string }) => await api.adminQuarantine({ token, targetType: v.targetType, targetId: v.targetId, itemTitle: v.itemTitle ?? "", note: "", reportId: v.reportId ?? "" }), onSuccess: () => { setMsg("Quarantined — hidden everywhere, original preserved."); invalidate(); }, onError: fail });
  const restore = useMutation({ mutationFn: async (v: { targetType: "post" | "creator" | "vault_item" | "portfolio"; targetId: string; itemTitle?: string }) => await api.adminRestore({ token, targetType: v.targetType, targetId: v.targetId, itemTitle: v.itemTitle ?? "" }), onSuccess: () => { setMsg("Restored to public view."); invalidate(); }, onError: fail });
  const del = useMutation({ mutationFn: async (v: { targetType: "post" | "creator" | "vault_item" | "portfolio"; targetId: string; itemTitle?: string; reportId?: string }) => await api.adminDelete({ token, targetType: v.targetType, targetId: v.targetId, itemTitle: v.itemTitle ?? "", reportId: v.reportId ?? "" }), onSuccess: () => { setMsg("Permanently deleted."); setConfirmDel(null); invalidate(); }, onError: fail });
  const dismiss = useMutation({ mutationFn: async (id: string) => await api.adminDismissReport({ token, reportId: id }), onSuccess: invalidate, onError: fail });
  const ban = useMutation({ mutationFn: async (v: { accountId: string; banned: boolean }) => await api.adminSetBan({ token, accountId: v.accountId, banned: v.banned }), onSuccess: () => { setMsg("Ban setting updated."); invalidate(); }, onError: fail });
  const grant = useMutation({ mutationFn: async (v: { accountId: string; amount: number }) => await api.adminGrantCredits({ token, accountId: v.accountId, amount: v.amount }), onSuccess: () => { setMsg("Standing granted (admin grant, logged)."); invalidate(); }, onError: fail });
  const verify = useMutation({ mutationFn: async (v: { accountId: string; verified: boolean }) => await api.adminSetVerified({ token, accountId: v.accountId, verified: v.verified }), onSuccess: () => { setMsg("Verification updated — logged. Verifying awards +20 standing, once."); invalidate(); }, onError: fail });
  const strike = useMutation({ mutationFn: async (v: { accountId: string; note: string }) => await api.adminAddStrike({ token, accountId: v.accountId, note: v.note }), onSuccess: () => { setMsg("Strike added — it shows on their My Profile and in the log."); invalidate(); }, onError: fail });
  const ghost = useMutation({ mutationFn: async () => await api.adminRunGhostCheck({ token }), onSuccess: (r) => { setMsg(r.marked > 0 ? `Ghost check done: ${r.marked} job(s) marked released-by-platform.` : "Ghost check done: nothing due."); invalidate(); }, onError: fail });
  const setRole = useMutation({ mutationFn: async (v: { accountId: string; role: "member" | "mod" }) => await api.adminSetRole({ token, accountId: v.accountId, role: v.role }), onSuccess: () => { setMsg("Role updated — logged."); invalidate(); }, onError: fail });
  const [debtAmt, setDebtAmt] = useState<Record<string, number>>({});
  const recordDebt = useMutation({ mutationFn: async (v: { accountId: string; amount: number }) => await api.adminRecordRefundDebt({ token, accountId: v.accountId, amount: v.amount, note: "" }), onSuccess: () => { setMsg("Refund balance recorded — the seller's new commissions and quotes are now paused until it's settled."); invalidate(); }, onError: fail });
  const clearDebt = useMutation({ mutationFn: async (accountId: string) => await api.adminClearRefundDebt({ token, accountId }), onSuccess: () => { setMsg("Refund balance cleared — selling unpaused."); invalidate(); }, onError: fail });
  const [coverAmt, setCoverAmt] = useState<Record<string, number>>({});
  const cover = useMutation({ mutationFn: async (v: { commissionId: string; amount: number }) => await api.adminCoverRefund({ token, commissionId: v.commissionId, amount: v.amount }), onSuccess: () => { setMsg("Trust Pool cover paid — the buyer has it now, and the amount is the seller's refund balance."); invalidate(); }, onError: fail });
  const btn = "btn-playful px-3 py-1.5 text-[11px] font-bold";
  if (admin.isPending) return <p className="text-center text-sm font-semibold text-slate-500 py-10">Opening the owner controls… 🛡</p>;
  if (admin.error || !admin.data) return <NotFound />;
  const d: AdminState = admin.data;
  const openReports = d.reports.filter(r => r.status === "open");
  return (
    <section className="max-w-4xl mx-auto">
      <div className="bg-slate-700 px-5 py-5 border border-slate-600">
        <h1 className="display text-3xl leading-tight text-white">{isDev ? "Dev controls 🛠" : "Moderator controls 🛡"}</h1>
        <p className="text-slate-300 text-sm mt-1">{isDev ? "Your account is the dev account — the full control set lives here. Moderators you appoint later see the moderation subset (reports, quarantine, bans, strikes) — never invite codes, roles, refund balances, Trust Pool covers or standing grants." : "You're a moderator: reports, quarantine, bans and strikes are yours. Invite codes, roles, refund balances, Trust Pool covers and standing grants stay with the dev account."} Every action is checked again on the server and written to the moderation log.</p>
      </div>
      {msg && <p className="mt-3 text-sm font-bold text-slate-700 bg-amber-50 border border-amber-200 px-3 py-2" role="status">{msg}</p>}

      <div className="square mt-4 bg-rose-50 border-2 border-rose-300 p-5" style={{ borderRadius: 0 }} role="note" aria-label="Worst-case guidance">
        <h2 className="display text-xl text-rose-700">⚠ If the worst shows up — read this first</h2>
        <p className="mt-2 text-[15px] text-slate-600 leading-relaxed">If material appears to be <strong>child sexual abuse material</strong> or <strong>non-consensual / assault material</strong>: <strong>Quarantine it immediately</strong> — quarantine hides it from everyone while preserving the original untouched as evidence. <strong>Do NOT download or copy it to personal devices.</strong> Then report it to <strong>Cybertip.ca</strong> and your local police as soon as possible. <strong>Do not warn or tip off the uploader. Deleting before reporting can destroy evidence</strong> — so quarantine first, report, and only delete when the authorities say the evidence is no longer needed.</p>
      </div>

      {isDev && <div className="square mt-4 bg-white border border-slate-100 p-5 shadow-[5px_5px_0_#dbeafe]" style={{ borderRadius: 0 }}>
        <h2 className="display text-2xl text-slate-700">🎟 Invite codes</h2>
        <p className="text-sm text-slate-500 mt-1">Sign-up is closed without a code. Generate codes for your testers — each code works exactly its number of uses, then stops.</p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div><label htmlFor="invUses" className="text-xs font-bold text-slate-600">Uses for the new code</label><input id="invUses" type="number" min={1} max={100} value={maxUses} onChange={e => setMaxUses(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} className="mt-1 block w-24 px-3 py-2 border border-slate-200 mono" /></div>
          <button type="button" disabled={gen.isPending} onClick={() => gen.mutate()} className={`${btn} bg-[#34d399] text-white !px-4 !py-2.5 !text-sm disabled:opacity-50`} aria-label="Generate a new invite code">{gen.isPending ? "Making…" : "Generate code"}</button>
          {lastCode && <span className="mono font-bold text-slate-700 bg-amber-100 px-3 py-2" aria-label="Most recently generated invite code">{lastCode}</span>}
        </div>
        {d.invites.length === 0 ? <p className="mt-3 text-sm text-slate-500">No codes yet — generate the first one for your testers.</p> : (
          <ul className="mt-3 divide-y divide-slate-100">
            {d.invites.map(i => (
              <li key={i.id} className="py-2.5 flex flex-wrap items-center gap-2">
                <span className="mono font-bold text-slate-700">{i.code}</span>
                <span className="pill px-2.5 py-1 text-[10px] font-bold bg-sky-100 text-sky-700">{i.usesCount} of {i.maxUses} used</span>
                {i.disabled ? <span className="pill px-2.5 py-1 text-[10px] font-bold bg-rose-100 text-rose-600">Disabled</span> : i.usesCount >= i.maxUses ? <span className="pill px-2.5 py-1 text-[10px] font-bold bg-slate-100 text-slate-500">Used up</span> : <span className="pill px-2.5 py-1 text-[10px] font-bold bg-emerald-100 text-emerald-700">Active</span>}
                <span className="text-[12px] text-slate-400">{new Date(i.createdAt).toLocaleDateString()}</span>
                {!i.disabled && <button type="button" disabled={disableInv.isPending} onClick={() => disableInv.mutate(i.id)} className={`${btn} bg-white border border-rose-200 text-rose-500 ml-auto disabled:opacity-50`} aria-label={`Disable invite code ${i.code}`}>Disable</button>}
              </li>
            ))}
          </ul>
        )}
      </div>}

      <div className="square mt-4 bg-white border border-slate-100 p-5 shadow-[5px_5px_0_#fef3c7]" style={{ borderRadius: 0 }}>
        <h2 className="display text-2xl text-slate-700">🚩 Reports queue {openReports.length > 0 && <span className="pill bg-rose-500 text-white px-3 py-1 text-[11px] font-bold align-middle">{openReports.length} open</span>}</h2>
        {d.reports.length === 0 ? <p className="mt-2 text-sm text-slate-500">No reports yet. When someone taps Report on a post or page, it lands here.</p> : (
          <ul className="mt-3 divide-y divide-slate-100">
            {d.reports.map(r => (
              <li key={r.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-slate-700">{r.reason}</span>
                  <span className={`pill px-2.5 py-1 text-[10px] font-bold ${r.status === "open" ? "bg-rose-100 text-rose-600" : r.status === "dismissed" ? "bg-slate-100 text-slate-500" : "bg-emerald-100 text-emerald-700"}`}>{r.status}</span>
                  <span className="text-[12px] text-slate-400">{new Date(r.createdAt).toLocaleString()}</span>
                </div>
                <p className="mt-1 text-sm text-slate-600">{r.targetLabel}{r.detail ? <> — “{r.detail}”</> : ""}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" onClick={() => navigate(r.targetHref)} className={`${btn} bg-sky-500 text-white`} aria-label={`View the reported content: ${r.targetLabel}`}>View content</button>
                  {r.status === "open" && <>
                    <button type="button" disabled={quar.isPending} onClick={() => quar.mutate({ targetType: r.targetType as "post" | "creator" | "vault_item" | "portfolio", targetId: r.targetId, itemTitle: r.itemTitle, reportId: r.id })} className={`${btn} bg-slate-700 text-white disabled:opacity-50`} aria-label="Quarantine the reported content">🛡 Quarantine</button>
                    {confirmDel === `rep-${r.id}` ? <><button type="button" disabled={del.isPending} onClick={() => del.mutate({ targetType: r.targetType as "post" | "creator" | "vault_item" | "portfolio", targetId: r.targetId, itemTitle: r.itemTitle, reportId: r.id })} className={`${btn} bg-rose-500 text-white disabled:opacity-50`} aria-label="Confirm permanent delete of the reported content">Yes, delete forever</button><button type="button" onClick={() => setConfirmDel(null)} className={`${btn} bg-white border border-slate-200 text-slate-500`} aria-label="Cancel deleting the reported content">Keep it</button></>
                    : <button type="button" onClick={() => setConfirmDel(`rep-${r.id}`)} className={`${btn} bg-white border border-rose-200 text-rose-500`} aria-label="Delete the reported content permanently">Delete</button>}
                    <button type="button" disabled={dismiss.isPending} onClick={() => dismiss.mutate(r.id)} className={`${btn} bg-white border border-slate-200 text-slate-500 disabled:opacity-50`} aria-label="Dismiss this report">Dismiss</button>
                  </>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="square mt-4 bg-white border border-slate-100 p-5 shadow-[5px_5px_0_#ffe4ec]" style={{ borderRadius: 0 }}>
        <h2 className="display text-2xl text-slate-700">🧊 Quarantine</h2>
        <p className="text-sm text-slate-500 mt-1">Quarantined content is hidden from every public surface, but the original data and media are preserved untouched in the database — that's the evidence copy. Restore if it was a mistake; delete only when you're sure it isn't needed as evidence.</p>
        {d.quarantine.length === 0 ? <p className="mt-2 text-sm text-slate-500">Nothing quarantined right now.</p> : (
          <ul className="mt-3 divide-y divide-slate-100">
            {d.quarantine.map((q, idx) => { const key = `${q.targetType}-${q.targetId}-${q.itemTitle}-${idx}`; return (
              <li key={key} className="py-3">
                <p className="font-bold text-slate-700">{q.title} <span className="pill px-2.5 py-1 text-[10px] font-bold bg-slate-700 text-white ml-1">{q.targetType === "portfolio" ? "portfolio item" : q.targetType === "vault_item" ? "vault item" : q.targetType}</span></p>
                <p className="text-[13px] text-slate-500 mt-0.5">By {q.ownerLabel}{q.quarantinedAt ? ` · quarantined ${new Date(q.quarantinedAt).toLocaleString()}` : ""}{q.note ? ` · Note: ${q.note}` : ""}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" disabled={restore.isPending} onClick={() => restore.mutate({ targetType: q.targetType as "post" | "creator" | "vault_item" | "portfolio", targetId: q.targetId, itemTitle: q.itemTitle })} className={`${btn} bg-emerald-500 text-white disabled:opacity-50`} aria-label={`Restore ${q.title} to public view`}>Restore</button>
                  {confirmDel === key ? <><button type="button" disabled={del.isPending} onClick={() => del.mutate({ targetType: q.targetType as "post" | "creator" | "vault_item" | "portfolio", targetId: q.targetId, itemTitle: q.itemTitle })} className={`${btn} bg-rose-500 text-white disabled:opacity-50`} aria-label={`Confirm permanent delete of ${q.title}`}>Yes, delete forever</button><button type="button" onClick={() => setConfirmDel(null)} className={`${btn} bg-white border border-slate-200 text-slate-500`} aria-label="Cancel deleting this quarantined item">Keep it</button></>
                  : <button type="button" onClick={() => setConfirmDel(key)} className={`${btn} bg-white border border-rose-200 text-rose-500`} aria-label={`Delete ${q.title} permanently`}>Delete permanently</button>}
                </div>
              </li> ); })}
          </ul>
        )}
      </div>

      <div className="square mt-4 bg-white border border-slate-100 p-5 shadow-[5px_5px_0_#d1fae5]" style={{ borderRadius: 0 }}>
        <h2 className="display text-2xl text-slate-700">👥 Accounts</h2>
        <p className="text-sm text-slate-500 mt-1">Banning logs the person out everywhere, blocks their logins, hides their page and posts — and <strong>burns their standing</strong> (balance and lifetime earned zeroed, logged). Verify = your manual ID check. Strikes show on the person's own My Profile. Top-ups grant standing (admin grants, logged).{isDev && <> <strong>Roles:</strong> appoint moderators here — they get reports, quarantine, bans and strikes, nothing money-shaped. <strong>Refund balance:</strong> a seller who owes a refund and hasn't paid carries it as a balance that pauses their new commissions and quotes until settled.</>}</p>
        <ul className="mt-3 divide-y divide-slate-100">
          {d.accounts.map(a => (
            <li key={a.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold text-slate-700">{a.displayName}</span>
                <span className="text-[13px] text-slate-400">@{a.username} · {a.email}</span>
                <span className="pill px-2.5 py-1 text-[10px] font-bold bg-violet-100 text-violet-700">{a.accountType}</span>
                {a.isOwner && <span className="pill px-2.5 py-1 text-[10px] font-bold bg-slate-700 text-white">🛠 dev</span>}
                {!a.isOwner && a.role === "mod" && <span className="pill px-2.5 py-1 text-[10px] font-bold bg-teal-600 text-white">🛡 moderator</span>}
                {a.refundDebt > 0 && <span className="pill px-2.5 py-1 text-[10px] font-bold bg-rose-500 text-white">💸 owes {money(a.refundDebt)} refund</span>}
                {a.isBanned && <span className="pill px-2.5 py-1 text-[10px] font-bold bg-rose-100 text-rose-600">banned</span>}
                <span className="pill px-2.5 py-1 text-[10px] font-bold bg-amber-100 text-amber-700">⭐ {a.credits} standing · L{a.level} {a.levelName}</span>
                {a.verified && <span className="pill px-2.5 py-1 text-[10px] font-bold bg-sky-500 text-white">✓ verified</span>}
                {a.strikes > 0 && <span className="pill px-2.5 py-1 text-[10px] font-bold bg-rose-100 text-rose-600">⚠ {a.strikes} strike{a.strikes === 1 ? "" : "s"}</span>}
                {a.banEvasionFlag && <span className="pill px-2.5 py-1 text-[10px] font-bold bg-rose-500 text-white">⚠ Possible ban evasion — fingerprint match</span>}
              </div>
              {a.banEvasionFlag && <p className="mt-1 text-[12px] font-semibold text-rose-500">Tripwire only: this signup's device fingerprint matches a banned account's. Fingerprints are spoofable and devices get shared — judge it yourself; nothing automatic has happened.</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {!a.isOwner && (a.isBanned
                  ? <button type="button" disabled={ban.isPending} onClick={() => ban.mutate({ accountId: a.id, banned: false })} className={`${btn} bg-emerald-500 text-white disabled:opacity-50`} aria-label={`Unban ${a.username}`}>Unban</button>
                  : <button type="button" disabled={ban.isPending} onClick={() => ban.mutate({ accountId: a.id, banned: true })} className={`${btn} bg-rose-500 text-white disabled:opacity-50`} aria-label={`Ban ${a.username}`}>Ban</button>)}
                {isDev && <button type="button" disabled={verify.isPending} onClick={() => verify.mutate({ accountId: a.id, verified: !a.verified })} className={`${btn} ${a.verified ? "bg-white border border-slate-300 text-slate-500" : "bg-sky-500 text-white"} disabled:opacity-50`} aria-label={`${a.verified ? "Remove verification from" : "Verify"} ${a.username}`}>{a.verified ? "Unverify" : "✓ Verify (ID checked)"}</button>}
                {isDev && !a.isOwner && (a.role === "mod"
                  ? <button type="button" disabled={setRole.isPending} onClick={() => setRole.mutate({ accountId: a.id, role: "member" })} className={`${btn} bg-white border border-teal-300 text-teal-700 disabled:opacity-50`} aria-label={`Remove moderator role from ${a.username}`}>Remove moderator</button>
                  : <button type="button" disabled={setRole.isPending} onClick={() => setRole.mutate({ accountId: a.id, role: "mod" })} className={`${btn} bg-teal-600 text-white disabled:opacity-50`} aria-label={`Make ${a.username} a moderator`}>🛡 Make moderator</button>)}
                <span className="flex items-center gap-1.5">
                  <label htmlFor={`strike-${a.id}`} className="text-[11px] font-bold text-slate-500">Strike</label>
                  <input id={`strike-${a.id}`} value={strikeNote[a.id] ?? ""} onChange={e => setStrikeNote({ ...strikeNote, [a.id]: e.target.value })} placeholder="Reason for the strike" className="w-44 px-2 py-1.5 border border-slate-200 text-sm" />
                  <button type="button" disabled={strike.isPending || !(strikeNote[a.id] ?? "").trim()} onClick={() => strike.mutate({ accountId: a.id, note: (strikeNote[a.id] ?? "").trim() })} className={`${btn} bg-rose-100 text-rose-600 border border-rose-200 disabled:opacity-50`} aria-label={`Add a strike to ${a.username}`}>Add strike</button>
                </span>
                {isDev && <span className="flex items-center gap-1.5">
                  <label htmlFor={`grant-${a.id}`} className="text-[11px] font-bold text-slate-500">Top up</label>
                  <input id={`grant-${a.id}`} type="number" min={1} max={100000} value={grantAmt[a.id] ?? 500} onChange={e => setGrantAmt({ ...grantAmt, [a.id]: Number(e.target.value) || 0 })} className="w-24 px-2 py-1.5 border border-slate-200 mono text-sm" />
                  <button type="button" disabled={grant.isPending || !(grantAmt[a.id] ?? 500)} onClick={() => grant.mutate({ accountId: a.id, amount: grantAmt[a.id] ?? 500 })} className={`${btn} bg-amber-400 text-slate-700 disabled:opacity-50`} aria-label={`Grant standing to ${a.username}`}>Grant standing</button>
                </span>}
                {isDev && !a.isOwner && <span className="flex items-center gap-1.5">
                  <label htmlFor={`debt-${a.id}`} className="text-[11px] font-bold text-slate-500">Refund owed $</label>
                  <input id={`debt-${a.id}`} type="number" min={1} max={100000} value={debtAmt[a.id] ?? 50} onChange={e => setDebtAmt({ ...debtAmt, [a.id]: Number(e.target.value) || 0 })} className="w-24 px-2 py-1.5 border border-slate-200 mono text-sm" />
                  <button type="button" disabled={recordDebt.isPending || !(debtAmt[a.id] ?? 50)} onClick={() => recordDebt.mutate({ accountId: a.id, amount: debtAmt[a.id] ?? 50 })} className={`${btn} bg-rose-100 text-rose-600 border border-rose-200 disabled:opacity-50`} aria-label={`Record a refund balance owed by ${a.username}`}>Record refund debt</button>
                  {a.refundDebt > 0 && <button type="button" disabled={clearDebt.isPending} onClick={() => clearDebt.mutate(a.id)} className={`${btn} bg-emerald-500 text-white disabled:opacity-50`} aria-label={`Clear the refund balance for ${a.username} (settled)`}>Clear debt (settled)</button>}
                </span>}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {isDev && <div className="square mt-4 bg-white border border-emerald-100 p-5 shadow-[5px_5px_0_#d1fae5]" style={{ borderRadius: 0 }}>
        <h2 className="display text-2xl text-slate-700">💧 Trust Pool — cover a scammed buyer instantly</h2>
        <p className="text-sm text-slate-500 mt-1">Your ruling: when a scam is <strong>provable from the job's own record</strong> (deadline passed, nothing delivered — or an escalated job), the pool pays the buyer <strong>instantly</strong>, no claim form, no waiting after proof. The cover lands as standing in the buyer's account, paid from the platform's own funds (a goodwill policy, not insurance), and the <strong>same amount becomes the seller's refund balance</strong> — their selling pauses until they settle it. One cover per job, ever. Jobs below are the ones buyers walked away from or artists escalated.</p>
        {d.refundJobs.length === 0 ? <p className="mt-3 text-sm text-slate-500">No walked-away or escalated jobs right now — the pool is quiet.</p> : (
          <ul className="mt-3 divide-y divide-slate-100">
            {d.refundJobs.map(j => (
              <li key={j.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-slate-700">{j.title}</span>
                  <span className="text-[13px] text-slate-400">{j.buyerName} → {j.creatorName} · job {money(j.price)} · deposit {money(j.depositAmount)}</span>
                  <span className="pill px-2.5 py-1 text-[10px] font-bold bg-amber-100 text-amber-700">{j.status === "walked_away" ? "walked away" : j.status}</span>
                  {j.escalated && <span className="pill px-2.5 py-1 text-[10px] font-bold bg-rose-100 text-rose-600">escalated</span>}
                  {j.covered && <span className="pill px-2.5 py-1 text-[10px] font-bold bg-emerald-500 text-white">covered by the pool ✓</span>}
                </div>
                {!j.covered && <div className="mt-2 flex flex-wrap items-center gap-2">
                  <label htmlFor={`cover-${j.id}`} className="text-[11px] font-bold text-slate-500">Cover $</label>
                  <input id={`cover-${j.id}`} type="number" min={1} max={j.price} value={coverAmt[j.id] ?? j.depositAmount} onChange={e => setCoverAmt({ ...coverAmt, [j.id]: Number(e.target.value) || 0 })} className="w-24 px-2 py-1.5 border border-slate-200 mono text-sm" />
                  <button type="button" disabled={cover.isPending || !(coverAmt[j.id] ?? j.depositAmount)} onClick={() => cover.mutate({ commissionId: j.id, amount: coverAmt[j.id] ?? j.depositAmount })} className={`${btn} bg-emerald-500 text-white disabled:opacity-50`} aria-label={`Cover the buyer of ${j.title} from the Trust Pool`}>💧 Pay buyer from Trust Pool</button>
                  <span className="text-[12px] text-slate-400">Defaults to the deposit — the amount provably at risk. The seller's refund balance grows by the same amount.</span>
                </div>}
              </li>
            ))}
          </ul>
        )}
      </div>}

      <div className="square mt-4 bg-white border border-violet-100 p-5 shadow-[5px_5px_0_#ede9fe]" style={{ borderRadius: 0 }}>
        <h2 className="display text-2xl text-slate-700">👻 Ghost-release watch</h2>
        <p className="text-sm text-slate-500 mt-1">v2 jobs that are unlocked but never downloaded. After 7 unclaimed days the ghost-delivery licence lets the platform record them as released-by-platform — the file stays downloadable by the buyer; the mark is the record.</p>
        <button type="button" disabled={ghost.isPending} onClick={() => ghost.mutate()} className={`${btn} mt-3 bg-violet-500 text-white !px-4 !py-2 !text-sm disabled:opacity-50`} aria-label="Run the ghost-release check now">{ghost.isPending ? "Checking…" : "Run ghost-release check"}</button>
        {d.ghostJobs.length === 0 ? <p className="mt-3 text-sm text-slate-500">No unlocked-and-unclaimed jobs right now.</p> : (
          <ul className="mt-3 divide-y divide-slate-100">
            {d.ghostJobs.map(gj => (
              <li key={gj.id} className="py-2.5 flex flex-wrap items-center gap-2">
                <span className="font-bold text-slate-700">{gj.title}</span>
                <span className="text-[12px] text-slate-400">unlocked {new Date(gj.unlockedAt).toLocaleString()} · downloads: {gj.downloadCount}</span>
                {gj.ghostReleased ? <span className="pill px-2.5 py-1 text-[10px] font-bold bg-violet-500 text-white">released by platform ✓</span> : <span className="pill px-2.5 py-1 text-[10px] font-bold bg-amber-100 text-amber-700">ghost release in {gj.daysUntilGhost}d</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="square mt-4 bg-white border border-slate-100 p-5" style={{ borderRadius: 0 }}>
        <h2 className="display text-2xl text-slate-700">📜 Moderation log</h2>
        <p className="text-sm text-slate-500 mt-1">The evidence and decision trail — every owner action, in order. Read-only.</p>
        {d.log.length === 0 ? <p className="mt-2 text-sm text-slate-500">No actions logged yet.</p> : (
          <ul className="mt-3 space-y-0 mono text-[12px] max-h-[380px] overflow-y-auto">
            {d.log.map(l => (
              <li key={l.id} className="py-2 border-b border-dashed border-slate-200">
                <span className="font-bold text-slate-700">{l.action}</span> <span className="text-slate-500">· {l.targetType}{l.targetId ? ` ${l.targetId}` : ""} · by {l.actorLabel} · {new Date(l.createdAt).toLocaleString()}</span>
                {l.note && <span className="block text-slate-500 font-sans text-[12px] mt-0.5">{l.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function NotFound() {
  return (
    <section className="square bg-white border border-rose-100 shadow-[6px_6px_0_#ffe4ec] p-6 md:p-10 text-center" style={{ borderRadius: 0 }}>
      <div className="flex justify-center"><Starburst color="#fbcfe8" className="tilt-l">Oops!</Starburst></div>
      <h1 className="display text-4xl leading-tight text-slate-700 mt-4">This page wandered off ✿</h1>
      <p className="text-slate-500 mt-2 max-w-md mx-auto">The address you opened doesn't match any shop, job or shelf here. It may have been mistyped, or the page moved.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button onClick={() => navigate("/")} className="btn-playful px-6 py-3 bg-[#ff6b6b] text-white font-bold text-sm shadow-[3px_3px_0_#fde047]" aria-label="Go back home">← Back home</button>
        <button onClick={() => navigate("/search")} className="btn-playful px-6 py-3 bg-white border border-pink-200 text-pink-500 font-bold text-sm" aria-label="Browse the creators">Browse creators</button>
      </div>
    </section>
  );
}

function ThemeEditor({ creator, draft, setDraft, taxonomy, cats, setCats, onSave, saving, onReset, resetting, msg }: { creator: Creator; draft: Theme; setDraft: (t: Theme) => void; taxonomy: TaxonomyItem[]; cats: string[]; setCats: (c: string[]) => void; onSave: () => void; saving: boolean; onReset: () => void; resetting: boolean; msg: string }) {
  const toggleCat = (name: string) => setCats(cats.includes(name) ? cats.filter(c => c !== name) : cats.length >= 6 ? cats : [...cats, name]);
  const set = (patch: Partial<Theme>) => setDraft({ ...draft, ...patch });
  const setPortfolio = (title: string, v: string) => { const next = { ...draft.portfolioImages }; if (v) next[title] = v; else delete next[title]; setDraft({ ...draft, portfolioImages: next }); };
  return (
    <div className="square mt-4 bg-white border-2 border-dashed border-violet-300 p-4 md:p-5" style={{ borderRadius: 0 }} aria-label="Page customization editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="display text-2xl text-slate-700">🎨 Customize my page</h2>
        <span className="pill bg-violet-100 text-violet-700 px-3 py-1 text-[11px] font-bold">Live preview — the page below updates as you play</span>
      </div>
      <p className="text-sm text-slate-500 mt-1">Your colours and pictures, your shop. The layout, square corners and escrow machinery stay put — everything decorative is yours. Uploads are shrunk a little so pages stay speedy.</p>
      <div className="mt-4">
        <h3 className="text-sm font-bold text-slate-600 mb-2">Profile picture &amp; banner</h3>
        <div className="grid md:grid-cols-2 gap-3">
          <ImageSlot label="Profile picture (pfp)" value={draft.pfpUrl} onChange={v => set({ pfpUrl: v })} maxDim={400} kind="profile" />
          <ImageSlot label="Profile banner (wide strip at the top)" value={draft.bannerUrl} onChange={v => set({ bannerUrl: v })} maxDim={1200} kind="banner" />
        </div>
      </div>
      <div className="mt-4">
        <h3 className="text-sm font-bold text-slate-600 mb-2">Colours — anywhere you like</h3>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <ColorField label="Page background" value={draft.bgColor} onChange={v => set({ bgColor: v })} />
          <ColorField label="Panel / card colour" value={draft.panelColor} onChange={v => set({ panelColor: v })} />
          <ColorField label="Accent (buttons & links)" value={draft.accent} onChange={v => set({ accent: v })} />
          <ColorField label="Secondary accent" value={draft.accent2} onChange={v => set({ accent2: v })} />
          <ColorField label="Heading text" value={draft.headingColor} onChange={v => set({ headingColor: v })} />
          <ColorField label="Body text" value={draft.bodyColor} onChange={v => set({ bodyColor: v })} />
        </div>
      </div>
      <div className="mt-4">
        <h3 className="text-sm font-bold text-slate-600 mb-2">Pictures around the page</h3>
        <div className="grid md:grid-cols-2 gap-3">
          <ImageSlot label="Page background image (soft white overlay keeps text readable)" value={draft.bgImageUrl} onChange={v => set({ bgImageUrl: v })} maxDim={1200} kind="background" />
          <ImageSlot label="About / showcase image (shows under your bio)" value={draft.showcaseUrl} onChange={v => set({ showcaseUrl: v })} maxDim={1000} kind="showcase" />
        </div>
      </div>
      <div className="mt-4">
        <h3 className="text-sm font-bold text-slate-600 mb-2">Portfolio pictures — swap any placeholder for your real art</h3>
        <p className="text-[13px] text-slate-500 mb-2">Your page shows {4 + creator.extraPortfolioTiles} portfolio tiles (4 included + {creator.extraPortfolioTiles} from perks). Buy "+4 portfolio tiles" with standing on My Profile to show more.</p>
        <div className="grid md:grid-cols-2 gap-3">
          {creator.portfolio.map((p, i) => i < 4 + creator.extraPortfolioTiles
            ? <ImageSlot key={p.title} label={`Portfolio: ${p.title}`} value={draft.portfolioImages[p.title] ?? ""} onChange={v => setPortfolio(p.title, v)} maxDim={900} kind="portfolio" />
            : <div key={p.title} className="border border-dashed border-slate-300 p-3 bg-slate-50"><p className="text-xs font-bold text-slate-500">Portfolio: {p.title}</p><p className="mt-1 text-[12px] text-slate-400">Locked — this tile is past your allowance. It unlocks when you buy more tiles with standing.</p></div>)}
        </div>
      </div>
      <div className="mt-4">
        <h3 className="text-sm font-bold text-slate-600 mb-1">How I take payment — your own accounts, your own links</h3>
        <p className="text-[13px] text-slate-500 mb-2">Up to 3 methods. Buyers pay <strong>you directly</strong> on these — the platform never holds payments and never sees your credentials. Links must be http(s); anything else goes in the instructions.</p>
        <div className="space-y-2">
          {draft.paymentMethods.map((m, i) => (
            <div key={i} className="border border-slate-200 p-3 bg-white grid md:grid-cols-3 gap-2">
              <div><label htmlFor={`payLabel${i}`} className="text-[11px] font-bold text-slate-500">Label</label><input id={`payLabel${i}`} value={m.label} onChange={e => { const next = [...draft.paymentMethods]; next[i] = { ...m, label: e.target.value }; set({ paymentMethods: next }); }} placeholder="e.g. Ko-fi" className="mt-1 w-full px-2 py-2 border border-slate-200 text-sm" /></div>
              <div><label htmlFor={`payLink${i}`} className="text-[11px] font-bold text-slate-500">Payment link (optional)</label><input id={`payLink${i}`} value={m.link} onChange={e => { const next = [...draft.paymentMethods]; next[i] = { ...m, link: e.target.value }; set({ paymentMethods: next }); }} placeholder="https://…" className="mt-1 w-full px-2 py-2 border border-slate-200 text-sm" /></div>
              <div className="flex gap-2 items-end"><div className="flex-1"><label htmlFor={`payHow${i}`} className="text-[11px] font-bold text-slate-500">Instructions (optional)</label><input id={`payHow${i}`} value={m.instructions} onChange={e => { const next = [...draft.paymentMethods]; next[i] = { ...m, instructions: e.target.value }; set({ paymentMethods: next }); }} placeholder="e.g. e-Transfer to my email" className="mt-1 w-full px-2 py-2 border border-slate-200 text-sm" /></div><button type="button" onClick={() => set({ paymentMethods: draft.paymentMethods.filter((_, j) => j !== i) })} className="btn-playful px-2.5 py-2 bg-white border border-rose-200 text-rose-500 text-[11px] font-bold" aria-label={`Remove payment method ${i + 1}`}>Remove</button></div>
            </div>
          ))}
          {draft.paymentMethods.length < 3 && <button type="button" onClick={() => set({ paymentMethods: [...draft.paymentMethods, { label: "", link: "", instructions: "" }] })} className="btn-playful px-4 py-2 bg-sky-500 text-white text-xs font-bold" aria-label="Add a payment method">+ Add payment method</button>}
        </div>
        <h3 className="text-sm font-bold text-slate-600 mb-1 mt-5">Crypto wallets — buyers send it themselves ₿</h3>
        <p className="text-[13px] text-slate-500 mb-2">Prefer crypto? List a <strong>public receive address</strong> per network (up to 4). Buyers send from <strong>their own wallet</strong>, paste the transaction ID into the job, and the transaction checker confirms it — the deposit and the unlock then happen <strong>automatically</strong>. You choose your rails: external links above, crypto here, or both. <strong>Never paste a private key or seed phrase</strong> — the site only ever needs the public address, and it never buys, holds or sends crypto for anyone.</p>
        <div className="space-y-2">
          {draft.cryptoWallets.map((w, i) => (
            <div key={i} className="border border-amber-200 p-3 bg-amber-50/50 grid md:grid-cols-3 gap-2">
              <div><label htmlFor={`walNet${i}`} className="text-[11px] font-bold text-slate-500">Network</label><select id={`walNet${i}`} value={w.network} onChange={e => { const next = [...draft.cryptoWallets]; next[i] = { ...w, network: e.target.value }; set({ cryptoWallets: next }); }} className="mt-1 w-full px-2 py-2 border border-slate-200 text-sm bg-white">{CRYPTO_NETWORKS.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}</select></div>
              <div><label htmlFor={`walAddr${i}`} className="text-[11px] font-bold text-slate-500">Public address ({CRYPTO_NETWORKS.find(n => n.id === w.network)?.addressHint ?? ""})</label><input id={`walAddr${i}`} value={w.address} onChange={e => { const next = [...draft.cryptoWallets]; next[i] = { ...w, address: e.target.value }; set({ cryptoWallets: next }); }} placeholder="Your public receive address" className="mt-1 w-full px-2 py-2 border border-slate-200 text-sm mono" spellCheck={false} /></div>
              <div className="flex gap-2 items-end"><div className="flex-1"><label htmlFor={`walLabel${i}`} className="text-[11px] font-bold text-slate-500">Label (optional)</label><input id={`walLabel${i}`} value={w.label} onChange={e => { const next = [...draft.cryptoWallets]; next[i] = { ...w, label: e.target.value }; set({ cryptoWallets: next }); }} placeholder="e.g. Main wallet" className="mt-1 w-full px-2 py-2 border border-slate-200 text-sm" /></div><button type="button" onClick={() => set({ cryptoWallets: draft.cryptoWallets.filter((_, j) => j !== i) })} className="btn-playful px-2.5 py-2 bg-white border border-rose-200 text-rose-500 text-[11px] font-bold" aria-label={`Remove crypto wallet ${i + 1}`}>Remove</button></div>
            </div>
          ))}
          {draft.cryptoWallets.length < 4 && <button type="button" onClick={() => set({ cryptoWallets: [...draft.cryptoWallets, { network: CRYPTO_NETWORKS.find(n => !draft.cryptoWallets.some(w => w.network === n.id))?.id ?? "btc", address: "", label: "" }] })} className="btn-playful px-4 py-2 bg-amber-400 text-slate-700 text-xs font-bold" aria-label="Add a crypto wallet">+ Add crypto wallet</button>}
        </div>
        <label className="mt-3 flex items-start gap-2 text-sm font-semibold text-slate-600 cursor-pointer"><input type="checkbox" checked={draft.verifiedOnly} onChange={e => set({ verifiedOnly: e.target.checked })} className="mt-0.5 w-4 h-4 shrink-0" /> Verified buyers only — only buyers whose ID the owner has verified can send me requests.</label>
      </div>
      <div className="mt-4">
        <h3 className="text-sm font-bold text-slate-600 mb-1">Categories — what you make, so buyers can find you</h3>
        <p className="text-[13px] text-slate-500 mb-2">Pick up to 6. These power the Search page — choose the ones that truly fit your work. <span className="font-bold text-slate-600">{cats.length} of 6 picked</span>{cats.length >= 6 ? " — that's the full set! Remove one to swap." : ""}</p>
        <CategoryChips taxonomy={taxonomy} selected={cats} onToggle={toggleCat} max={6} />
      </div>
      {msg && <p className="mt-3 text-sm font-bold" role="status">{msg}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={onSave} disabled={saving} className="pill btn-playful px-6 py-3 bg-[#34d399] text-white font-bold text-sm disabled:opacity-50" aria-label="Save my page customization">{saving ? "Saving…" : "Save my page ✓"}</button>
        <button type="button" onClick={onReset} disabled={resetting} className="pill btn-playful px-5 py-3 bg-white border border-rose-200 text-rose-500 font-bold text-sm disabled:opacity-50" aria-label="Reset page customization to default">Reset to default</button>
      </div>
    </div>
  );
}

function PostComposer({ creator, taxonomy, token }: { creator: Creator; taxonomy: TaxonomyItem[]; token: string }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priceNote, setPriceNote] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [videoErr, setVideoErr] = useState("");
  const [cats, setCats] = useState<string[]>([]);
  const [msg, setMsg] = useState("");
  const create = useMutation({
    mutationFn: async () => await api.createPost({ token, title: title.trim(), body: body.trim(), priceNote: priceNote.trim(), imageUrl, videoUrl, categories: cats }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["posts"] }); qc.invalidateQueries({ queryKey: ["myPosts"] }); setTitle(""); setBody(""); setPriceNote(""); setImageUrl(""); setVideoUrl(""); setCats([]); setMsg("Posted! It's live at the top of the Home offer feed. ✦"); },
    onError: (e) => setMsg(String(e instanceof Error ? e.message : e)),
  });
  const toggleCat = (name: string) => setCats(prev => prev.includes(name) ? prev.filter(c => c !== name) : prev.length >= 3 ? prev : [...prev, name]);
  const submit = (e: FormEvent) => { e.preventDefault(); setMsg(""); if (!title.trim()) { setMsg("Give your post a title first."); return; } if (!body.trim()) { setMsg("Tell buyers what you're offering."); return; } create.mutate(); };
  const inputCls = "mt-1 w-full px-4 py-3 bg-white border border-slate-200 text-sm text-slate-600";
  return (
    <form onSubmit={submit} className="square mt-6 bg-white border-2 border-dashed border-pink-300 p-5 md:p-6" style={{ borderRadius: 0 }} aria-label="Post an offer">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="display text-[26px] text-slate-700">📣 Post an offer</h2>
          <p className="text-sm mt-1 text-slate-500">This lands on the Home feed under your name, linked to this page. Say what's open, what's included, and when it ends.</p>
        </div>
        <span className="hidden sm:block"><Starburst color="#fbcfe8" className="tilt-r">Tell everyone!</Starburst></span>
      </div>
      <div className="mt-3"><label htmlFor="postTitle" className="text-xs font-bold text-slate-600">Title <span className="font-semibold text-slate-400">({title.length}/80)</span></label><input id="postTitle" value={title} onChange={e => setTitle(e.target.value)} maxLength={80} placeholder="e.g. Portrait slots open — 3 left this week" className={inputCls} /></div>
      <div className="mt-3"><label htmlFor="postBody" className="text-xs font-bold text-slate-600">What's the offer? <span className="font-semibold text-slate-400">({body.length}/600)</span></label><textarea id="postBody" value={body} onChange={e => setBody(e.target.value)} maxLength={600} rows={4} placeholder="What you're offering, what's included, how it works…" className={inputCls} /></div>
      <div className="mt-3"><label htmlFor="postPrice" className="text-xs font-bold text-slate-600">Price note <span className="font-semibold text-slate-400">(optional, {priceNote.length}/60)</span></label><input id="postPrice" value={priceNote} onChange={e => setPriceNote(e.target.value)} maxLength={60} placeholder="e.g. $45 per slot · 3 open" className={inputCls} /></div>
      <div className="mt-3"><ImageSlot label="Picture (optional)" value={imageUrl} onChange={setImageUrl} maxDim={1000} kind="post_image" /></div>
      <div className="mt-3 border border-slate-200 p-3 bg-white">
        <p className="text-xs font-bold text-slate-600">Video clip (optional) — small MP4 only, under 2 MB</p>
        {videoUrl ? (
          <div className="mt-2">
            <video src={videoUrl} controls preload="metadata" playsInline className="w-full max-h-56 bg-black" aria-label="Preview of the video attached to this post" />
            <button type="button" onClick={() => setVideoUrl("")} className="btn-playful mt-2 px-3 py-2 bg-white border border-rose-200 text-rose-500 text-xs font-bold" aria-label="Remove the attached video">Remove video</button>
          </div>
        ) : (
          <div className="mt-2">
            <label htmlFor="postVideoFile" className="btn-playful cursor-pointer inline-block px-3 py-2 bg-sky-500 text-white text-xs font-bold">Upload MP4 clip</label>
            <input id="postVideoFile" type="file" accept="video/mp4" className="hidden" onChange={async e => {
              const f = e.target.files?.[0]; e.target.value = "";
              if (!f) return;
              setVideoErr("");
              if (f.type !== "video/mp4") { setVideoErr("That file isn't an MP4 — only small .mp4 clips work here."); return; }
              if (f.size > 2 * 1024 * 1024) { setVideoErr("That clip is over 2 MB — trim it down and try again."); return; }
              try { setVideoUrl(await uploadAsset(f, "post_video")); } catch (err) { setVideoErr(String(err instanceof Error ? err.message : err)); }
            }} />
            <p className="mt-1.5 text-[12px] text-slate-400">Short clips play right in the feed — perfect for turntables, process videos and reels.</p>
          </div>
        )}
        {videoErr && <p className="mt-1 text-[12px] font-bold text-rose-500" role="alert">{videoErr}</p>}
      </div>
      <div className="mt-3">
        <p className="text-xs font-bold text-slate-600 mb-1">Categories <span className="font-semibold text-slate-400">— up to 3, so the right buyers find it ({cats.length}/3)</span></p>
        <CategoryChips taxonomy={taxonomy} selected={cats} onToggle={toggleCat} max={3} />
      </div>
      {msg && <p className="mt-3 text-sm font-bold" role="status">{msg}</p>}
      <button type="submit" disabled={create.isPending} className="pill btn-playful mt-4 px-6 py-3 font-bold text-sm text-white disabled:opacity-50" style={{ background: creator.accent }} aria-label="Publish my offer post">{create.isPending ? "Posting…" : "Post it to the feed →"}</button>
    </form>
  );
}

function CreatorPage({ creator, taxonomy, account, token, back, onCreated }: { creator: Creator; taxonomy: TaxonomyItem[]; account: Account; token: string; back: () => void; onCreated: () => void }) {
  const qc = useQueryClient();
  /* Only the account that OWNS this page may decorate it — the server
     enforces the same rule on save/reset, this just hides the paint pots. */
  const mine = !!account && account.creatorId === creator.id;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Theme>(() => themeOf(creator));
  const [draftCats, setDraftCats] = useState<string[]>(() => creator.categories ?? []);
  const [themeMsg, setThemeMsg] = useState("");
  useEffect(() => { if (!editing) { setDraft(themeOf(creator)); setDraftCats(creator.categories ?? []); } }, [creator, editing]); // eslint-disable-line
  const theme: Theme = editing && mine ? draft : themeOf(creator);
  const shownCats: string[] = editing && mine ? draftCats : (creator.categories ?? []);
  const saveTheme = useMutation({ mutationFn: async () => await api.updateCreatorTheme({ token, creatorId: creator.id, ...draft, categories: draftCats }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["state"] }); setThemeMsg("Saved! Everyone visiting your page sees this look now. ✦"); }, onError: (e) => setThemeMsg(String(e instanceof Error ? e.message : e)) });
  const resetTheme = useMutation({ mutationFn: async () => await api.resetCreatorTheme({ token, creatorId: creator.id }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["state"] }); setEditing(false); setThemeMsg(""); }, onError: (e) => setThemeMsg(String(e instanceof Error ? e.message : e)) });
  const [buyerName, setBuyerName] = useState("Alex R.");
  const [revisions, setRevisions] = useState(2);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [refs, setRefs] = useState("");
  const [budget, setBudget] = useState(150);
  const [kind, setKind] = useState<"standard" | "extended">("standard");
  const [payChoice, setPayChoice] = useState<string | null>(null);
  /* The buyer picks the payment rail from the ones THIS artist offers:
     external links, and/or send-it-yourself crypto per listed wallet. */
  const payMethod = payChoice ?? (creator.paymentMethods.length > 0 ? "external" : creator.cryptoWallets.length > 0 ? `crypto:${creator.cryptoWallets[0]!.network}` : "");
  const [msg, setMsg] = useState("");
  const create = useMutation({ mutationFn: async () => await api.createCommission({ creatorId: creator.id, buyerName, title, brief, refsText: refs, budget, kind, token, revisionsTotal: revisions, payMethod }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["state"] }); setMsg("Request sent — it's in the inbox as a new Brief."); setTimeout(onCreated, 900); }, onError: (e) => setMsg(String(e)) });
  const isAdmin = !!account?.isAdmin || account?.role === "mod";
  const [adminMsg, setAdminMsg] = useState("");
  const [confirmDeletePage, setConfirmDeletePage] = useState(false);
  const qPage = useMutation({ mutationFn: async () => await api.adminQuarantine({ token, targetType: "creator", targetId: creator.id, itemTitle: "", note: "", reportId: "" }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["state"] }); setAdminMsg("Page quarantined — hidden everywhere. It's preserved in the Admin quarantine list."); setTimeout(back, 1200); }, onError: (e) => setAdminMsg(String(e instanceof Error ? e.message : e)) });
  const dPage = useMutation({ mutationFn: async () => await api.adminDelete({ token, targetType: "creator", targetId: creator.id, itemTitle: "", reportId: "" }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["state"] }); setTimeout(back, 600); }, onError: (e) => setAdminMsg(String(e instanceof Error ? e.message : e)) });
  const qItem = useMutation({ mutationFn: async (t: string) => await api.adminQuarantine({ token, targetType: "portfolio", targetId: creator.id, itemTitle: t, note: "", reportId: "" }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["state"] }); setAdminMsg("Portfolio item quarantined — hidden from the page, original preserved."); }, onError: (e) => setAdminMsg(String(e instanceof Error ? e.message : e)) });
  const shownPortfolio = creator.hasOwner ? creator.portfolio.slice(0, 4 + creator.extraPortfolioTiles) : creator.portfolio;
  const blockedByVerifiedOnly = creator.verifiedOnly && (!account || !account.verified);
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  const inputCls = "mt-1 w-full px-4 py-3 bg-white border border-slate-200 text-sm text-slate-600";
  return (
    <section className="relative -mx-3 px-3 py-3" style={{ background: theme.bgColor, color: theme.bodyColor }}>
      {theme.bgImageUrl && <><SafeImg src={theme.bgImageUrl} alt="" className="absolute inset-0 w-full h-full object-cover pointer-events-none" /><div className="absolute inset-0 bg-white/70 pointer-events-none" /></>}
      <div className="relative">
      <div className="flex flex-wrap gap-2 items-center">
        <button onClick={back} className="btn-playful text-sm font-bold text-sky-600 bg-sky-50 px-3 py-1.5 border border-sky-100" aria-label="Back to all creators">← Back to all shops</button>
        {mine && <button onClick={() => { setDraft(themeOf(creator)); setThemeMsg(""); setEditing(e => !e); }} className="pill btn-playful text-sm font-bold text-white px-4 py-1.5" style={{ background: theme.accent }} aria-label={editing ? "Close the page customizer" : "Customize my page"}>{editing ? "✕ Close customizer" : "🎨 Customize my page"}</button>}
        <ReportButton token={token} targetType="creator" targetId={creator.id} label="Report page" />
        {isAdmin && <>
          <button type="button" disabled={qPage.isPending} onClick={() => qPage.mutate()} className="btn-playful px-3 py-1.5 bg-slate-700 text-white text-[12px] font-bold disabled:opacity-50" aria-label={`Quarantine ${creator.name}'s whole page (owner)`}>🛡 Quarantine page</button>
          {confirmDeletePage ? <span className="flex items-center gap-2"><span className="text-[12px] font-bold text-rose-500">Delete this page forever?</span><button type="button" disabled={dPage.isPending} onClick={() => dPage.mutate()} className="btn-playful px-3 py-1.5 bg-rose-500 text-white text-[12px] font-bold disabled:opacity-50" aria-label="Confirm permanent delete of this creator page">Yes, delete</button><button type="button" onClick={() => setConfirmDeletePage(false)} className="btn-playful px-3 py-1.5 bg-white border border-slate-200 text-slate-500 text-[12px] font-bold" aria-label="Cancel deleting this page">Keep it</button></span>
          : <button type="button" onClick={() => setConfirmDeletePage(true)} className="btn-playful px-3 py-1.5 bg-white border border-rose-200 text-rose-500 text-[12px] font-bold" aria-label={`Delete ${creator.name}'s page permanently (owner)`}>Delete page</button>}
        </>}
      </div>
      {adminMsg && <p className="mt-2 text-sm font-bold text-slate-600 bg-white border border-slate-200 px-3 py-2 inline-block" role="status">{adminMsg}</p>}
      {!creator.hasOwner && <p className="mt-3 inline-block text-[13px] font-semibold text-slate-500 bg-amber-50 border border-amber-100 px-3 py-2">★ Sample page — this is a demo storefront, so its look is locked. Sign up as a creator and you'll get your own page to decorate however you like!</p>}
      {creator.hasOwner && !mine && <p className="mt-3 inline-block text-[13px] font-semibold text-slate-500 bg-sky-50 border border-sky-100 px-3 py-2">You're visiting {creator.name}'s page — only they can redecorate it.</p>}
      {editing && mine && <ThemeEditor creator={creator} draft={draft} setDraft={setDraft} taxonomy={taxonomy} cats={draftCats} setCats={setDraftCats} onSave={() => saveTheme.mutate()} saving={saveTheme.isPending} onReset={() => resetTheme.mutate()} resetting={resetTheme.isPending} msg={themeMsg} />}
      <div className="square mt-4 border border-slate-100 overflow-hidden" style={{ borderRadius: 0, background: theme.panelColor, boxShadow: `6px 6px 0 ${theme.accent}33` }}>
        {theme.bannerUrl ? (
          <div className="relative h-36 md:h-48 overflow-hidden" style={{ background: theme.accent, outline: creator.bannerFrame ? `6px solid ${theme.accent2}` : undefined, outlineOffset: -6 }}>
            <SafeImg src={theme.bannerUrl} alt={`${creator.name}'s banner`} className="absolute inset-0 w-full h-full object-cover" />
            {creator.bannerFrame && <span className="pill absolute top-2 right-2 px-2 py-0.5 bg-white/90 text-[10px] font-bold text-slate-500">⭐ banner frame perk</span>}
          </div>
        ) : <div className="h-3" style={{ background: theme.accent }} />}
        <Wavy color={theme.accent} />
        <div className="p-5 md:p-7">
          <div className="flex gap-4 flex-wrap"><div className="relative w-20 h-20 shrink-0 overflow-hidden flex items-center justify-center text-white display text-3xl" style={{ background: theme.accent, boxShadow: `4px 4px 0 ${theme.accent}44` }}>{theme.pfpUrl ? <SafeImg src={theme.pfpUrl} alt={`${creator.name}'s profile picture`} className="absolute inset-0 w-full h-full object-cover" /> : creator.name.slice(0, 2)}<span className="absolute -top-0 -right-0 text-amber-400 text-lg z-10">★</span></div><div className="flex-1 min-w-[200px]"><div className="flex flex-wrap items-center gap-2"><h1 className="display text-4xl leading-tight" style={{ color: theme.headingColor, textShadow: creator.nameGlow ? `0 0 14px ${theme.accent2}, 0 0 3px ${theme.accent}` : undefined }}>{creator.name}</h1>{creator.verified && <VerifiedBadge />}{creator.status === "open" ? <span className="pill bg-emerald-100 text-emerald-700 px-3 py-1 text-[11px] font-bold tilt-sm inline-block">● Open — say hi!</span> : <span className="pill bg-amber-100 text-amber-700 px-3 py-1 text-[11px] font-bold tilt-r inline-block">◐ Waitlist</span>}</div><p className="text-[13px] font-semibold mt-1" style={{ color: theme.accent }}>{creator.handle} · {creator.tagline}</p><div className="mt-2 flex flex-wrap gap-1.5" aria-label={`${creator.name}'s record`}><span className="pill px-2.5 py-1 text-[10px] font-bold bg-white border border-slate-200 text-slate-600">🎨 {creator.jobsCompleted} jobs completed</span><span className="pill px-2.5 py-1 text-[10px] font-bold bg-white border border-slate-200 text-slate-600">⏱ {creator.onTimePct}% on time</span><span className="pill px-2.5 py-1 text-[10px] font-bold bg-violet-100 text-violet-700">⭐ Level {creator.level} · {creator.levelName}</span>{creator.verifiedOnly && <span className="pill px-2.5 py-1 text-[10px] font-bold bg-sky-100 text-sky-700">Verified buyers only</span>}</div>{shownCats.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5" aria-label={`${creator.name}'s categories`}>{shownCats.map(cat => <button key={cat} type="button" onClick={() => navigate(searchPath("", [cat], "any", "relevance"))} className="pill px-2.5 py-1 text-[10px] font-bold border bg-white/80 hover:bg-white" style={{ borderColor: `${theme.accent}88`, color: theme.headingColor }} aria-label={`Find more creators in ${cat}`}>{cat}</button>)}</div>}<div className="mt-3"><Speech color="#fdf2f8">{creator.bio}</Speech></div>{theme.showcaseUrl && <div className="mt-3 relative border border-slate-200 overflow-hidden max-h-72" style={{ background: theme.panelColor }}><SafeImg src={theme.showcaseUrl} alt={`${creator.name}'s showcase`} className="w-full max-h-72 object-cover" /></div>}<p className="text-[12px] font-semibold opacity-70">Turnaround: {creator.turnaround}</p></div></div>
          <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-3">{shownPortfolio.map(p => <ArtTile key={p.title} hue={p.hue} title={p.title} kind={p.kind} watermark image={theme.portfolioImages[p.title]} />)}</div>
          <div className="mt-2 flex flex-wrap gap-2 items-center">
            {shownPortfolio.map(p => <span key={p.title} className="flex items-center gap-1.5"><ReportButton token={token} targetType="portfolio" targetId={creator.id} itemTitle={p.title} label={`Report “${p.title}”`} />{isAdmin && <button type="button" disabled={qItem.isPending} onClick={() => qItem.mutate(p.title)} className="btn-playful px-2.5 py-1.5 bg-slate-700 text-white text-[11px] font-bold disabled:opacity-50" aria-label={`Quarantine portfolio item ${p.title} (owner)`}>🛡 Quarantine “{p.title}”</button>}</span>)}
          </div>
          <div className="mt-6 grid md:grid-cols-3 gap-4">
            <div className="border border-slate-100 overflow-hidden" style={{ boxShadow: `4px 4px 0 ${theme.accent}22`, background: theme.panelColor }}><div className="px-4 py-2.5 text-white font-bold text-sm flex items-center gap-2" style={{ background: theme.accent }}><Icon name="coin" className="w-4 h-4" /> Price menu</div><table className="w-full text-sm">{creator.prices.map((p, i) => <tr key={p.label} className={`border-t border-slate-100 ${i % 2 ? "bg-amber-50/60" : ""}`}><td className="px-4 py-3" style={{ color: theme.bodyColor }}>{p.label}</td><td className="px-4 py-3 text-right mono font-bold" style={{ color: theme.headingColor }}>{money(p.price)}</td></tr>)}</table></div>
            <div className="border border-emerald-100 overflow-hidden shadow-[4px_4px_0_#d1fae5]" style={{ background: theme.panelColor }}><div className="px-4 py-2.5 text-white font-bold text-sm" style={{ background: theme.accent2 }}>✓ Happy to do</div><ul className="p-4 space-y-2 text-sm" style={{ color: theme.bodyColor }}>{creator.willDo.map(w => <li key={w} className="border-b border-dashed border-emerald-100 pb-1.5">♥ {w}</li>)}</ul></div>
            <div className="border border-rose-100 overflow-hidden shadow-[4px_4px_0_#ffe4e6]" style={{ background: theme.panelColor }}><div className="px-4 py-2.5 bg-rose-300 text-white font-bold text-sm">✕ Not for me</div><ul className="p-4 space-y-2 text-sm" style={{ color: theme.bodyColor }}>{creator.wontDo.map(w => <li key={w} className="border-b border-dashed border-rose-100 pb-1.5">✕ {w}</li>)}</ul><p className="px-4 pb-3 text-[12px] opacity-70">Sorted before any money exists — no awkward surprises.</p></div>
          </div>
          <div className="mt-4 border border-sky-100 overflow-hidden shadow-[4px_4px_0_#dbeafe]" style={{ background: theme.panelColor }}>
            <div className="px-4 py-2.5 text-white font-bold text-sm flex items-center gap-2" style={{ background: theme.accent }}><Icon name="shield" className="w-4 h-4" /> How I take payment</div>
            <div className="p-4">
              <p className="text-sm" style={{ color: theme.bodyColor }}>You pay {creator.name} <strong>directly, on their own account</strong> — deposit first, balance when the finished piece is locked in the Vault. The platform choreographs the steps and holds the artwork and the record; it never holds your payment, so it can't refund payments either — the milestones keep any single payment small.</p>
              {creator.paymentMethods.length > 0 ? <ul className="mt-3 space-y-2">{creator.paymentMethods.map((m, i) => <li key={i} className="border border-slate-100 px-3 py-2 text-sm"><span className="font-bold text-slate-700">{m.label}</span>{m.instructions && <span className="block text-slate-500 mt-0.5">{m.instructions}</span>}{m.link && <a href={m.link} target="_blank" rel="noreferrer" className="font-bold text-sky-600 underline underline-offset-2 break-all" aria-label={`Open ${creator.name}'s payment link for ${m.label}`}>{m.link}</a>}</li>)}</ul> : creator.cryptoWallets.length === 0 ? <p className="mt-2 text-[13px] text-slate-400">This artist hasn't listed payment methods yet — ask in your brief, and they'll confirm how the deposit works before anything is due.</p> : null}
              {creator.cryptoWallets.length > 0 && <>
                <p className="mt-4 text-sm font-bold text-slate-700">₿ Or pay by crypto — you send it yourself</p>
                <p className="text-[13px] text-slate-500 mt-0.5">Send from <strong>your own wallet</strong> to the address below, then paste the transaction ID into the job — the transaction checker confirms it and releases the next step automatically. The site never buys or sends crypto for you, and never holds it.</p>
                <ul className="mt-2 space-y-2">{creator.cryptoWallets.map((w, i) => <li key={i} className="border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm"><span className="font-bold text-slate-700">{cryptoNetName(w.network)}</span>{w.label && <span className="text-slate-500"> · {w.label}</span>}<span className="block mono text-[12px] text-slate-600 break-all mt-0.5 select-all">{w.address}</span></li>)}</ul>
              </>}
            </div>
          </div>
        </div>
      </div>
      {mine && <PostComposer creator={creator} taxonomy={taxonomy} token={token} />}
      {/* Bubble-style brief box — the one soft element, like a chat bubble */}
      <form onSubmit={submit} className="bubble mt-6 bg-[#eff6ff] border border-sky-100 p-5 md:p-6 shadow-[5px_5px_0_#dbeafe]" aria-label={`Commission ${creator.name}`}>
        <div className="flex items-start justify-between gap-3"><div><h2 className="display text-[28px]" style={{ color: theme.headingColor }}>💬 Paste your brief</h2><p className="text-sm mt-1 text-slate-500">It pops into {creator.name}'s inbox like a sealed envelope with a bow on it. They quote it, you pay the deposit <strong>directly to them</strong>, and work only starts once they confirm it landed.</p>{creator.verifiedOnly && <p className="mt-2 text-[13px] font-bold text-sky-700 bg-sky-50 border border-sky-100 px-3 py-2">This creator takes requests from <strong>verified buyers only</strong>.{account ? (account.verified ? " You're verified — you're in! ✓" : " Your account isn't verified yet, so the button below is paused — ask the site owner for the quick manual ID check.") : " Log in with a verified account to send one."}</p>}</div><span className="hidden sm:block"><Starburst color="#fbcfe8" className="tilt-l">Start here!</Starburst></span></div>
        <div className="grid md:grid-cols-2 gap-3 mt-3">
          <div><label htmlFor="buyerName" className="text-xs font-bold">Your name</label><input id="buyerName" value={buyerName} onChange={e => setBuyerName(e.target.value)} className={inputCls} required /></div>
          <div><label htmlFor="jobTitle" className="text-xs font-bold">Title</label><input id="jobTitle" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Half-body portrait of my OC" className={inputCls} required /></div>
        </div>
        <div className="mt-3"><label htmlFor="brief" className="text-xs font-bold">What are you looking for?</label><textarea id="brief" value={brief} onChange={e => setBrief(e.target.value)} rows={4} placeholder="Character, mood, setting, colours, must-haves…" className={inputCls} required /></div>
        <div className="mt-3"><label htmlFor="refs" className="text-xs font-bold">References</label><input id="refs" value={refs} onChange={e => setRefs(e.target.value)} placeholder="Links or descriptions" className={inputCls} /></div>
        <div className="grid md:grid-cols-3 gap-3 mt-3">
          <div><label htmlFor="budget" className="text-xs font-bold">Your budget ($)</label><input id="budget" type="number" min={10} value={budget} onChange={e => setBudget(Number(e.target.value))} className={inputCls + " mono"} required /></div>
          <div><label htmlFor="kind" className="text-xs font-bold">Job type</label><select id="kind" value={kind} onChange={e => setKind(e.target.value as any)} className={inputCls + " bg-white"}><option value="standard">Standard — 7-day target</option><option value="extended">Extended — runs longer</option></select></div>
          <div><label htmlFor="revisionsWanted" className="text-xs font-bold">Sketch revisions included</label><select id="revisionsWanted" value={revisions} onChange={e => setRevisions(Number(e.target.value))} className={inputCls + " bg-white"}>{[0, 1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} revision{n === 1 ? "" : "s"}</option>)}</select></div>
        </div>
        {(creator.paymentMethods.length > 0 || creator.cryptoWallets.length > 0) && (
          <div className="mt-3"><label htmlFor="payRail" className="text-xs font-bold">How you'll pay</label>
            <select id="payRail" value={payMethod} onChange={e => setPayChoice(e.target.value)} className={inputCls + " bg-white"}>
              {creator.paymentMethods.length > 0 && <option value="external">Directly to the artist — their payment links</option>}
              {creator.cryptoWallets.map(w => <option key={w.network} value={`crypto:${w.network}`}>Crypto — {cryptoNetName(w.network)} (you send it yourself)</option>)}
            </select>
            {payMethod.startsWith("crypto:") && <p className="mt-1 text-[12px] text-slate-500">You'll need the crypto already in your own wallet — the site can't buy or send it for you. After each send, you paste the transaction ID into the job and the checker releases the next step automatically.</p>}
          </div>
        )}
        <p className="mt-2 text-[13px] text-slate-500">Signed in, this starts the milestone flow: Brief → Quote → Deposit → Sketch → Vault → Balance → Unlock. Signed out, it's a demo request on the old flow.</p>
        {msg && <p className="mt-3 text-sm font-bold" role="status">{msg}</p>}
        <button type="submit" disabled={create.isPending || blockedByVerifiedOnly} className="pill mt-4 px-6 py-3 font-bold text-sm text-white border border-slate-200 hover:brightness-110 disabled:opacity-50" style={{ background: theme.accent }} aria-label="Send commission request">{blockedByVerifiedOnly ? "Verified buyers only" : "Send request →"}</button>
      </form>
      </div>
    </section>
  );
}

function Jobs({ data, selectedId, onSelect, act, token, account }: { data: State; selectedId: string | null; onSelect: (id: string) => void; act: any; token: string; account: Account }) {
  const job = data.commissions.find(c => c.id === selectedId) ?? data.commissions[0];
  const inbox = data.commissions.filter(c => ["requested", "countered", "brief", "quoted"].includes(c.status));
  return (
    <section>
      <div className="bg-sky-50 px-5 py-4 border border-sky-100 flex justify-between items-center"><h1 className="display text-3xl leading-tight text-slate-700">Inbox &amp; jobs 📬</h1><span className="pill mono text-xs bg-white text-sky-700 border border-sky-100 px-3 py-1 font-bold">{inbox.length}  waiting</span></div>
      {/* Phones (<560px): stacked job cards — no table, no sideways scroll, nothing clipped */}
      <div className="mt-3 space-y-2 min-[560px]:hidden">
        {data.commissions.map(c => (
          <div key={c.id} className={`square bg-white border border-slate-200 p-3 ${job?.id === c.id ? "bg-[#fff3e6]" : ""}`} style={{ borderRadius: 0 }}>
            <p className="font-bold text-slate-700 leading-snug">{c.title}</p>
            <p className="mt-1 text-sm text-slate-500">{c.buyerName} • <span className="mono font-bold text-slate-700">{money(c.price)}</span></p>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="pill px-2.5 py-1 text-[11px] font-bold text-white" style={{ background: c.status === "in_progress" ? "#34d399" : c.status === "disputed" ? "#fb7185" : c.status === "released" ? "#a78bfa" : "#64748b" }}>{STATUS_LABEL[c.status] ?? c.status}</span>
              <button onClick={() => onSelect(c.id)} className="shrink-0 px-4 py-1.5 border border-slate-200 bg-white font-bold text-xs hover:bg-sky-100" aria-label={`Open job ${c.title}`}>Open</button>
            </div>
          </div>
        ))}
      </div>
      {/* Wider screens: the table, with fixed layout so the Status column can never be squeezed below the pill's full one-line width */}
      <div className="square mt-3 bg-white border border-slate-200 max-[559px]:hidden" style={{ borderRadius: 0 }}><table className="w-full text-sm" style={{ tableLayout: "fixed" }}><colgroup><col style={{ width: "32%" }} /><col style={{ width: "17%" }} /><col style={{ width: "12%" }} /><col style={{ width: "24%" }} /><col style={{ width: "15%" }} /></colgroup><thead><tr className="bg-violet-50 border-b border-violet-100 text-left text-[13px] text-slate-500"><th className="p-3">Job</th><th className="p-2">Buyer</th><th className="p-2">Amount</th><th className="p-2">Status</th><th className="p-2"></th></tr></thead><tbody>
        {data.commissions.map(c => (<tr key={c.id} className={`border-b border-neutral-300 ${job?.id === c.id ? "bg-[#fff3e6]" : ""}`}><td className="p-3 font-bold text-slate-700">{c.title}</td><td className="p-3 text-slate-500">{c.buyerName}</td><td className="p-3 mono font-bold text-slate-700">{money(c.price)}</td><td className="p-3 text-slate-500"><span className="pill px-2 py-0.5 text-[10px] font-bold text-white" style={{ background: c.status === "in_progress" ? "#34d399" : c.status === "disputed" ? "#fb7185" : c.status === "released" ? "#a78bfa" : "#64748b" }}>{STATUS_LABEL[c.status] ?? c.status}</span></td><td className="p-3 text-slate-500"><button onClick={() => onSelect(c.id)} className="px-3 py-1 border border-slate-200 bg-white font-bold text-xs hover:bg-sky-100" aria-label={`Open job ${c.title}`}>Open</button></td></tr>))}
      </tbody></table></div>
      {job && <JobDetail job={job} data={data} act={act} token={token} account={account} />}
    </section>
  );
}


function MilestoneJobDetail({ job, data, token }: { job: Comm; data: State; token: string }) {
  const qc = useQueryClient();
  const creator = data.creators.find(c => c.id === job.creatorId);
  const ledger = data.ledger.filter(l => l.commissionId === job.id);
  const [quotePrice, setQuotePrice] = useState(job.budget);
  const [depositAmt, setDepositAmt] = useState(Math.round(job.budget / 2));
  const [sketchData, setSketchData] = useState("");
  const [vaultOriginal, setVaultOriginal] = useState("");
  const [vaultPreview, setVaultPreview] = useState("");
  const [vaultName, setVaultName] = useState("");
  const [msg, setMsg] = useState("");
  const [dlMsg, setDlMsg] = useState("");
  const [depositTxid, setDepositTxid] = useState("");
  const [balanceTxid, setBalanceTxid] = useState("");
  const act2 = useMutation({
    mutationFn: async (v: { action: string; extra?: Record<string, unknown>; txid?: string }) => await api.milestoneAct({ token, id: job.id, action: v.action as never, quotePrice, depositAmount: depositAmt, sketchImageUrl: sketchData, vaultFileUrl: vaultOriginal, vaultPreviewUrl: vaultPreview, vaultFileName: vaultName, txid: v.txid ?? "", ...(v.extra ?? {}) } as never),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["state"] }); qc.invalidateQueries({ queryKey: ["session"] }); setMsg(""); },
    onError: (e) => setMsg(String(e instanceof Error ? e.message : e)),
  });
  const run = (action: string) => { setMsg(""); act2.mutate({ action }); };
  const runTx = (action: string, txid: string) => { setMsg(""); act2.mutate({ action, txid }); };
  /* Crypto rail for this job ("" = external/direct payments). The wallet
     shown is the artist's CURRENT listed wallet on that network. */
  const net = job.payMethod.startsWith("crypto:") ? job.payMethod.slice("crypto:".length) : "";
  const wallet = net ? (creator?.cryptoWallets ?? []).find(w => w.network === net) : undefined;
  const walletBox = wallet ? (
    <div className="mt-2 border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm"><span className="font-bold text-slate-700">Send {cryptoNetName(net)} to the artist's wallet:</span>{wallet.label && <span className="text-slate-500"> · {wallet.label}</span>}<span className="block mono text-[12px] text-slate-600 break-all mt-0.5 select-all">{wallet.address}</span></div>
  ) : net ? <p className="mt-2 text-[13px] font-semibold text-rose-500">The artist no longer lists a {cryptoNetName(net)} wallet on their page — ask them to re-add it before sending anything.</p> : null;
  const checkerNote = <p className="mt-2 text-[12px] text-slate-400">Beta checker: simulated for the closed test — it validates the transaction ID against this job's record and drives the real state change. Live on-chain confirmation counting arrives with hosting; the flow you see is the flow that ships.</p>;
  const download = useMutation({
    mutationFn: async () => await api.downloadVaultFile(job.id),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ["state"] }); setDlMsg(`Original downloaded — download #${r.downloadCount} is written into the job record.`); },
    onError: (e) => setDlMsg(String(e instanceof Error ? e.message : e)),
  });
  const btn = "btn-playful px-4 py-2.5 text-sm font-bold border border-slate-100 shadow-[3px_3px_0_#e0e7ff]";
  const primary = { background: "#ff6b6b", color: "#fff", boxShadow: "3px 3px 0 #fde047" } as const;
  const ghostB = { background: "#fff", color: "#64748b" } as const;
  const danger = { background: "#fff1f2", color: "#e11d48", borderColor: "#fecdd3" } as const;
  const balanceDue = Math.max(0, job.price - job.depositAmount);
  const deadlinePassed = job.deadline ? Date.now() > new Date(job.deadline).getTime() : false;
  const deemedAt = job.sketchSubmittedAt ? new Date(new Date(job.sketchSubmittedAt).getTime() + 3 * 24 * 3600 * 1000) : null;
  const deemedDue = deemedAt ? Date.now() >= deemedAt.getTime() : false;
  const vaultAgeDays = job.vaultDeliveredAt ? Math.floor((Date.now() - new Date(job.vaultDeliveredAt).getTime()) / 86400000) : 0;
  const payMethods = creator?.paymentMethods ?? [];
  const payList = payMethods.length > 0 ? (
    <ul className="mt-2 space-y-1.5">{payMethods.map((m, i) => <li key={i} className="border border-slate-200 bg-white px-3 py-2 text-sm"><span className="font-bold text-slate-700">{m.label}</span>{m.instructions && <span className="block text-slate-500">{m.instructions}</span>}{m.link && <a href={m.link} target="_blank" rel="noreferrer" className="font-bold text-sky-600 underline underline-offset-2 break-all" aria-label={`Open the artist's payment link for ${m.label}`}>{m.link}</a>}</li>)}</ul>
  ) : <p className="mt-2 text-[13px] text-slate-500">The artist hasn't listed payment methods on their page yet — they confirm how to pay in the job thread before any money is due.</p>;
  const onSketchFile = async (f: File | undefined) => { if (!f) return; try { setSketchData(await fileToAssetRef(f, "sketch", 900)); setMsg(""); } catch (e) { setMsg(String(e instanceof Error ? e.message : e)); } };
  const onVaultFile = async (f: File | undefined) => {
    if (!f) return;
    setMsg("");
    try {
      if (f.type === "video/mp4") {
        if (f.size > 2 * 1024 * 1024) { setMsg("That clip is over 2 MB — trim it down and try again."); return; }
        setVaultOriginal(await uploadAsset(f, "vault_original")); setVaultPreview(await makeVideoPreview(f)); setVaultName(f.name);
      } else if (f.type.startsWith("image/")) {
        setVaultOriginal(await fileToAssetRef(f, "vault_original", 1600));
        setVaultPreview(await makeWatermarkedPreview(f));
        setVaultName(f.name);
      } else { setMsg("The Vault takes an image or a small MP4 — that file type won't fit."); }
    } catch (e) { setMsg(String(e instanceof Error ? e.message : e)); }
  };
  return (
    <div className="mt-4 grid lg:grid-cols-5 gap-4 items-start">
      <div className="lg:col-span-3 space-y-4 min-w-0">
        <div className="square bg-white border border-slate-200 shadow-[5px_5px_0_#dbeafe]" style={{ borderRadius: 0 }}>
          <div className="flex flex-wrap justify-between gap-2 px-3 py-2 border-b border-slate-100 bg-emerald-50"><h2 className="font-bold leading-tight flex-1">{job.title}</h2><span className="pill px-2.5 py-1 text-[11px] font-bold text-white h-fit" style={{ background: "#059669" }}>{STATUS_LABEL[job.status] ?? job.status}</span></div>
          <div className="p-5">
            <p className="text-[13px] font-semibold text-slate-400">{job.buyerName} → {creator?.name} • Quote {money(job.price)} • Deposit {money(job.depositAmount)}{job.depositConfirmed ? " ✓ confirmed" : ""} • Balance {money(balanceDue)} • Rev {job.revisionsUsed}/{job.revisionsTotal}</p>
            <p className="mt-1 text-[13px] font-semibold text-slate-500">{net ? <>₿ Pays by crypto — <span className="text-amber-600">{cryptoNetName(net)}</span>, sent by the buyer from their own wallet; the transaction checker confirms each payment and releases the next step automatically.</> : <>💳 Pays directly to the artist — external payment links; the artist confirms each payment by hand.</>}</p>
            <p className="mt-1 text-[13px] text-slate-500">Milestone job — money moves <strong>directly between buyer and artist</strong> on the artist's own payment account. The platform holds the artwork, the evidence and the reputation — never the money, so it can never refund a direct payment.</p>
            <div className="mt-5 flex flex-wrap items-start gap-y-3 pb-2 px-1" aria-label="Milestone progress">
              {V2_STEPS.map((stp, i) => { const cur = i === v2StepIndex(job); const done = i < v2StepIndex(job); return (<div key={stp} className="flex items-start shrink-0"><div className="flex flex-col items-center w-[62px] min-[560px]:w-[78px]">{cur ? <span className="starburst flex items-center justify-center text-slate-700 font-bold" style={{ background: "#fde047", width: 52, height: 52, fontSize: 16 }}>{i + 1}★</span> : <div className="w-10 h-10 flex items-center justify-center text-base display shadow-[2px_2px_0_rgba(100,116,139,.15)]" style={{ background: done ? "#34d399" : "#f1f5f9", color: done ? "#fff" : "#94a3b8" }}>{done ? "✓" : i + 1}</div>}<p className={`text-[11px] font-bold mt-1.5 text-center leading-tight ${cur ? "text-amber-600" : "text-slate-500"}`}>{stp}{cur ? " ← you are here!" : ""}</p></div>{i < V2_STEPS.length - 1 && <div className="w-3 min-[560px]:w-6 mt-5 shrink-0 border-t-[3px] border-dashed" style={{ borderColor: i < v2StepIndex(job) ? "#34d399" : "#cbd5e1" }} />}</div>); })}
            </div>
            {(job.status === "walked_away" || job.status === "cancelled") && <p className="mt-3 text-sm border border-amber-300 bg-amber-50 p-3 font-semibold">{job.status === "walked_away" ? "This job closed by walk-away: the delivery deadline passed, so the buyer cancelled the remaining milestones. Money already paid directly for milestones actually delivered stands — the platform never held it and cannot refund it." : "This job is cancelled. The job record stays as the evidence of what was agreed and delivered."}</p>}
            {job.ghostReleased && <p className="mt-3 text-sm border border-violet-300 bg-violet-50 p-3 font-semibold">⭐ Released by platform (ghost release): the balance was confirmed paid and the file unlocked, and 7 days passed with no download — the platform recorded the delivery as released. The original is still downloadable by the buyer below.</p>}
            <div className="mt-4"><Speech color="#fef9c3">The brief — this is what everyone agreed to, in writing. ✎</Speech><div className="bubble bg-sky-50 border border-sky-100 p-4"><p className="text-[15px] text-slate-600 leading-relaxed">{job.brief}</p>{job.refsText && <p className="text-[13px] mt-2 text-slate-500">References: {job.refsText}</p>}</div></div>

            <div className="mt-4 space-y-3" aria-label="Milestone controls">
              {job.status === "brief" && (
                <div className="border border-slate-200 p-3 bg-[#fffef9]">
                  <p className="text-sm font-bold text-slate-700">Artist: quote this job</p>
                  <p className="text-[13px] text-slate-500 mt-0.5">Set the total and the deposit (50% is the house suggestion). Your level caps your quote{creator ? ` — this artist is Level ${creator.level} (${creator.levelName})` : ""}. Deadline: 7 days from deposit confirmation.</p>
                  <div className="mt-2 flex flex-wrap gap-2 items-end">
                    <div><label htmlFor="quotePrice" className="text-xs font-bold">Total $</label><input id="quotePrice" type="number" min={1} value={quotePrice} onChange={e => { const v = Number(e.target.value) || 0; setQuotePrice(v); setDepositAmt(Math.round(v / 2)); }} className="mt-1 block w-28 px-2 py-2 border border-slate-200 mono" /></div>
                    <div><label htmlFor="depositAmt" className="text-xs font-bold">Deposit $</label><input id="depositAmt" type="number" min={0} value={depositAmt} onChange={e => setDepositAmt(Number(e.target.value) || 0)} className="mt-1 block w-28 px-2 py-2 border border-slate-200 mono" /></div>
                    <button className={btn} style={primary} disabled={act2.isPending} onClick={() => run("quote")} aria-label="Artist sends the quote">Artist: Send quote</button>
                  </div>
                </div>
              )}
              {job.status === "quoted" && (
                <div className="border border-slate-200 p-3 bg-[#fffef9]">
                  {net ? <>
                    <p className="text-sm font-bold text-slate-700">Deposit: {money(job.depositAmount)} — pay by crypto ({cryptoNetName(net)})</p>
                    <p className="text-[13px] text-slate-500 mt-0.5">Buyer: send the deposit from <strong>your own wallet</strong> to the artist's address below — you need to already hold the crypto; the site can't buy or send it for you. Then paste the transaction ID here: the checker verifies it and confirms the deposit <strong>automatically</strong>. No work unlocks before that confirmation.</p>
                    {walletBox}
                    {!job.depositTx ? <>
                      <div className="mt-3"><label htmlFor="depositTxid" className="text-xs font-bold">Deposit transaction ID</label><input id="depositTxid" value={depositTxid} onChange={e => setDepositTxid(e.target.value)} placeholder="Paste the transaction hash from your wallet" className="mt-1 w-full px-3 py-2 border border-slate-200 text-sm mono" spellCheck={false} /></div>
                      <button className={`${btn} mt-2`} style={primary} disabled={act2.isPending || !depositTxid.trim()} onClick={() => runTx("submitDepositTx", depositTxid.trim())} aria-label="Buyer submits the deposit transaction ID">Buyer: Submit transaction ID</button>
                    </> : <>
                      <p className="mt-3 text-[13px] text-slate-600">Transaction submitted: <span className="mono break-all">{job.depositTx}</span></p>
                      <button className={`${btn} mt-2`} style={primary} disabled={act2.isPending} onClick={() => run("checkDepositTx")} aria-label="Run the transaction checker on the deposit">🔍 Run transaction check — confirm deposit automatically</button>
                    </>}
                    {checkerNote}
                  </> : <>
                    <p className="text-sm font-bold text-slate-700">Deposit: {money(job.depositAmount)} — buyer pays the artist directly</p>
                    <p className="text-[13px] text-slate-500 mt-0.5">Buyer: send the deposit using one of the artist's own payment methods below. Artist: once it lands in YOUR account, confirm it — no work unlocks before this confirmation, and the platform only records it, never touches it.</p>
                    {payList}
                    <button className={`${btn} mt-3`} style={primary} disabled={act2.isPending} onClick={() => run("confirmDeposit")} aria-label="Artist confirms the deposit was received">Artist: Mark deposit received</button>
                  </>}
                </div>
              )}
              {job.status === "deposit_paid" && (
                <div className="border border-slate-200 p-3 bg-[#fffef9]">
                  <p className="text-sm font-bold text-slate-700">Artist: make the sketch</p>
                  <p className="text-[13px] text-slate-500 mt-0.5">{job.sketchApproved ? "Sketch approved — head for the final piece below." : "Deposit confirmed, work is unlocked. Upload the sketch when it's ready — the buyer approves it (or uses a revision) before the final piece."}</p>
                  {!job.sketchApproved && <>
                    <div className="mt-2 flex flex-wrap gap-2 items-center">
                      <label htmlFor="sketchFile" className="btn-playful cursor-pointer px-3 py-2 bg-sky-500 text-white text-xs font-bold">Upload sketch image</label>
                      <input id="sketchFile" type="file" accept="image/*" className="hidden" onChange={e => { void onSketchFile(e.target.files?.[0]); e.target.value = ""; }} />
                      {sketchData && <img src={sketchData} alt="Sketch ready to submit" className="h-16 border border-slate-200 object-cover" />}
                    </div>
                    <button className={`${btn} mt-3`} style={primary} disabled={act2.isPending || !sketchData} onClick={() => run("submitSketch")} aria-label="Artist submits the sketch for approval">Artist: Submit sketch</button>
                  </>}
                </div>
              )}
              {job.status === "sketch_review" && (
                <div className="border border-slate-200 p-3 bg-[#fffef9]">
                  <p className="text-sm font-bold text-slate-700">Sketch gate — buyer's call</p>
                  {job.sketchImageUrl && <img src={job.sketchImageUrl} alt="Submitted sketch for this job" className="mt-2 max-h-64 border border-slate-200 object-contain bg-white" />}
                  <p className="text-[13px] text-slate-500 mt-2">{deemedAt ? (deemedDue ? "Three days of silence have passed — the sketch can now be deemed approved." : `If the buyer stays silent, this sketch counts as approved on ${deemedAt.toLocaleString()} (3 days after submission).`) : ""} Revisions used: {job.revisionsUsed} of {job.revisionsTotal}.</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button className={btn} style={primary} disabled={act2.isPending} onClick={() => run("approveSketch")} aria-label="Buyer approves the sketch">Buyer: Approve sketch ✓</button>
                    <button className={btn} style={ghostB} disabled={act2.isPending} onClick={() => run("requestRevision")} aria-label="Buyer requests a sketch revision">Buyer: Request revision ({job.revisionsUsed}/{job.revisionsTotal})</button>
                    <button className={btn} style={ghostB} disabled={act2.isPending || !deemedDue} onClick={() => run("deemedApprove")} aria-label="Apply deemed approval after 3 days of silence">Deemed approval (3 silent days)</button>
                  </div>
                </div>
              )}
              {job.status === "sketch_approved" && (
                <div className="border border-slate-200 p-3 bg-[#fffef9]">
                  <p className="text-sm font-bold text-slate-700">Artist: deliver the final piece to the Vault</p>
                  <p className="text-[13px] text-slate-500 mt-0.5">The original is stored server-side and served ONLY to the buyer after the balance is confirmed. The buyer sees a watermarked, downscaled preview — generated in your browser before upload — and nothing else.</p>
                  <div className="mt-2 flex flex-wrap gap-2 items-center">
                    <label htmlFor="vaultFile" className="btn-playful cursor-pointer px-3 py-2 bg-violet-500 text-white text-xs font-bold">Choose final file (image or MP4 ≤ 2 MB)</label>
                    <input id="vaultFile" type="file" accept="image/*,video/mp4" className="hidden" onChange={e => { void onVaultFile(e.target.files?.[0]); e.target.value = ""; }} />
                    {vaultPreview && <span className="relative inline-block border border-slate-200"><img src={vaultPreview} alt="Watermarked preview of the vault file" className="h-20 object-cover" /><span className="pill absolute bottom-1 left-1 px-2 py-0.5 bg-white/90 text-[10px] font-bold text-slate-500">buyer sees this preview</span></span>}
                    {vaultOriginal && !vaultPreview && <span className="text-[12px] font-bold text-slate-500">{vaultName} ready</span>}
                  </div>
                  <button className={`${btn} mt-3`} style={primary} disabled={act2.isPending || !vaultOriginal} onClick={() => run("deliverVault")} aria-label="Artist delivers the final piece to the Vault">Artist: Deliver to Vault</button>
                </div>
              )}
              {job.status === "vault_delivered" && (
                <div className="border border-slate-200 p-3 bg-[#fffef9]">
                  <p className="text-sm font-bold text-slate-700">In the Vault — balance: {money(balanceDue)}</p>
                  {job.vaultPreviewUrl ? <div className="relative mt-2 inline-block border border-slate-200 max-w-full"><img src={job.vaultPreviewUrl} alt="Watermarked preview of the delivered piece" className="max-h-64 object-contain bg-white" /><span className="pill absolute top-2 right-2 px-2 py-0.5 bg-white/90 text-[10px] font-bold text-slate-500 rotate-[-4deg]">PREVIEW — original locked</span></div> : <p className="mt-2 text-[13px] text-slate-500">A video piece is vaulted — its poster preview didn't render, and the original stays locked until unlock either way.</p>}
                  {net ? <>
                    <p className="text-[13px] text-slate-500 mt-2">Buyer: send the balance from <strong>your own wallet</strong> to the artist's address, then paste the transaction ID — the checker verifies it and the artwork <strong>unlocks automatically</strong>. Every download is logged.</p>
                    {walletBox}
                    {!job.balanceTx ? <>
                      <div className="mt-3"><label htmlFor="balanceTxid" className="text-xs font-bold">Balance transaction ID</label><input id="balanceTxid" value={balanceTxid} onChange={e => setBalanceTxid(e.target.value)} placeholder="Paste the transaction hash from your wallet" className="mt-1 w-full px-3 py-2 border border-slate-200 text-sm mono" spellCheck={false} /></div>
                      <button className={`${btn} mt-2`} style={primary} disabled={act2.isPending || !balanceTxid.trim()} onClick={() => runTx("submitBalanceTx", balanceTxid.trim())} aria-label="Buyer submits the balance transaction ID">Buyer: Submit transaction ID</button>
                    </> : <>
                      <p className="mt-3 text-[13px] text-slate-600">Transaction submitted: <span className="mono break-all">{job.balanceTx}</span></p>
                      <button className={`${btn} mt-2`} style={primary} disabled={act2.isPending} onClick={() => run("checkBalanceTx")} aria-label="Run the transaction checker on the balance and unlock the artwork">🔍 Run transaction check — UNLOCK automatically</button>
                    </>}
                    {checkerNote}
                  </> : <>
                    <p className="text-[13px] text-slate-500 mt-2">Buyer: pay the balance using the artist's own payment methods. Artist: confirm when it lands — confirmation unlocks the original for the buyer, and every download is logged.</p>
                    {payList}
                  </>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {!net && <button className={btn} style={primary} disabled={act2.isPending} onClick={() => run("confirmBalance")} aria-label="Artist confirms the balance was received and unlocks the artwork">Artist: Mark balance received — UNLOCK</button>}
                    {vaultAgeDays >= 7 ? <>
                      <button className={btn} style={danger} disabled={act2.isPending} onClick={() => run("escalate")} aria-label="Artist escalates the unpaid balance to the owner">Artist: Escalate to owner</button>
                      <button className={btn} style={ghostB} disabled={act2.isPending} onClick={() => run("withdrawVault")} aria-label="Artist withdraws the vault file after 7 unpaid days">Artist: Withdraw file</button>
                      <button className={btn} style={ghostB} disabled={act2.isPending} onClick={() => run("salvageVault")} aria-label="Artist routes the unpaid piece to Weekly Vault salvage">Artist: Send to Vault salvage</button>
                    </> : <span className="text-[12px] font-semibold text-slate-400 self-center">If the balance stays unpaid, the artist can escalate / withdraw / salvage after 7 days (day {vaultAgeDays} now).</span>}
                    {job.escalated === true && <span className="pill px-2.5 py-1 text-[11px] font-bold bg-rose-100 text-rose-600">Escalated to the owner</span>}
                  </div>
                </div>
              )}
              {job.status === "unlocked" && (
                <div className="border border-emerald-200 p-3 bg-emerald-50">
                  <p className="text-sm font-bold text-emerald-700">Unlocked — the original is yours, buyer ⭐</p>
                  <p className="text-[13px] text-slate-500 mt-0.5">Downloads so far: {job.downloadCount}. Every download is logged in the job record.{job.ghostReleased ? " This job was also marked released-by-platform (ghost release) after 7 unclaimed days." : " If it sits unclaimed for 7 days, the owner marks it released-by-platform (ghost release) in Admin."}</p>
                  <button className={`${btn} mt-2`} style={primary} disabled={download.isPending} onClick={() => download.mutate()} aria-label="Download the unlocked original file">{download.isPending ? "Fetching…" : "Buyer: Download original"}</button>
                  {dlMsg && <p className="mt-2 text-sm font-bold text-slate-600" role="status">{dlMsg}</p>}
                </div>
              )}
              {deadlinePassed && ["quoted", "deposit_paid", "sketch_review", "sketch_approved"].includes(job.status) && (
                <div className="border border-rose-200 p-3 bg-rose-50">
                  <p className="text-sm font-bold text-rose-600">Deadline missed</p>
                  <p className="text-[13px] text-slate-500 mt-0.5">The delivery deadline passed with this milestone undelivered. The buyer may walk away from all remaining milestones — money already paid directly for delivered milestones stands, and this record says so plainly.</p>
                  <button className={`${btn} mt-2`} style={danger} disabled={act2.isPending} onClick={() => run("walkAway")} aria-label="Buyer walks away from the remaining milestones">Buyer: Walk away</button>
                </div>
              )}
              {msg && <p className="text-sm font-bold text-rose-500 bg-rose-50 border border-rose-100 px-3 py-2" role="alert">{msg}</p>}
              {act2.isSuccess && !msg && <p className="text-sm font-bold text-emerald-600" role="status">Step recorded in the job record. ✓</p>}
            </div>
          </div>
        </div>
      </div>
      <aside className="square lg:col-span-2 min-w-0 bg-white border border-slate-200 lg:sticky lg:top-6 shadow-[5px_5px_0_#dbeafe]" style={{ borderRadius: 0 }}>
        <div className="bg-emerald-50 px-5 py-4"><h3 className="condensed text-xl">Job record — the evidence</h3><p className="mono text-[10px] opacity-80">Direct payments • Platform holds art + record, never money</p></div>
        <table className="w-full text-sm"><tbody>
          {[["Quote total", job.price], ["Deposit (direct)", job.depositAmount], ["Balance (direct)", balanceDue]].map(([label, amt]) => (
            <tr key={label as string} className="border-b border-slate-100 odd:bg-white even:bg-violet-50/50"><td className="p-3 text-slate-500 font-bold">{label}</td><td className="p-2 text-right mono font-bold text-base">{money(amt as number)}</td></tr>
          ))}
        </tbody></table>
        <div className="p-3"><h4 className="text-xs font-bold border-b border-slate-100 pb-1">Record feed</h4><div className="mt-2 space-y-0 max-h-[380px] overflow-y-auto mono text-[11px]">
          {ledger.length === 0 && <p className="py-2 text-neutral-500">No events yet — the artist quotes first.</p>}
          {ledger.map(l => (<div key={l.id} className="py-2 border-b border-dashed border-neutral-300"><p className="font-bold text-[12px] font-sans">{l.label} {l.amount > 0 && <span className="text-[#ff6b6b]">• {l.amount}</span>}</p><p className="text-neutral-500">{l.fromState} → {l.toState} • {new Date(l.createdAt).toLocaleString()}</p>{l.note && <p className="mt-0.5 text-neutral-600 font-sans text-[11px]">{l.note}</p>}</div>))}
        </div></div>
      </aside>
    </div>
  );
}

function JobDetail({ job, data, act, token, account }: { job: Comm; data: State; act: any; token: string; account: Account }) {
  if (job.isV2) return <MilestoneJobDetail job={job} data={data} token={token} />;
  /* Legacy demo controls are staff-only on the standalone build (the server
     enforces the same rule): dev/mod accounts see the actOnCommission
     buttons, everyone else gets the demo job read-only — status, delivery
     clock and ledger exactly as before, just no buttons. */
  const isStaff = account?.role === "dev" || account?.role === "mod";
  const [counter, setCounter] = useState(job.price + 20);
  const [disputeNote, setDisputeNote] = useState("Delivered character's outfit doesn't match the brief — brief said tavern bard with a lute; delivered has no lute and a different palette.");
  const creator = data.creators.find(c => c.id === job.creatorId);
  const ledger = data.ledger.filter(l => l.commissionId === job.id);
  const releasedAmt = job.kind === "extended" ? Math.min(job.price, job.blocksReleased * job.blockAmount) : (job.status === "released" ? job.price : 0);
  const lockedAmt = ["funded", "in_progress", "sketch_review", "delivered", "disputed"].includes(job.status) ? Math.max(0, job.price - releasedAmt) : 0;
  const reservedAmt = job.status === "reserved" ? job.price : 0;
  const btn = "btn-playful px-4 py-2.5 text-sm font-bold border border-slate-100 shadow-[3px_3px_0_#e0e7ff]";
  const primary = { background: "#ff6b6b", color: "#fff", boxShadow: "3px 3px 0 #fde047" } as const;
  const ghost = { background: "#fff", color: "#64748b" } as const;
  const danger = { background: "#fff1f2", color: "#e11d48", borderColor: "#fecdd3" } as const;
  const run = (action: string, extra?: any) => act.mutate({ id: job.id, action, ...extra });
  return (
    <div className="mt-4 grid lg:grid-cols-5 gap-4 items-start">
      <div className="lg:col-span-3 space-y-4 min-w-0">
        <div className="square bg-white border border-slate-200 shadow-[5px_5px_0_#dbeafe]" style={{ borderRadius: 0 }}>
          <div className="flex flex-wrap justify-between gap-2 px-3 py-2 border-b border-slate-100 bg-amber-50"><h2 className="font-bold leading-tight flex-1">{job.title}</h2><span className="pill px-2.5 py-1 text-[11px] font-bold text-white h-fit" style={{ background: "#64748b" }}>{STATUS_LABEL[job.status] ?? job.status}</span></div>
          <div className="p-5">
            <p className="text-[13px] font-semibold text-slate-400">{job.buyerName} → {creator?.name} • {money(job.price)} • {job.kind} • {job.rail} • Rev {job.revisionsUsed}/{job.revisionsTotal} • Sketch {job.sketchApproved ? "approved ✓" : "pending"}</p>
            {/* Playful stepper — numbered badges, dashed path, starburst for current */}
            <div className="mt-5 flex flex-wrap items-start gap-y-3 pb-2 px-1" aria-label="Commission progress">
              {STEPS.map((s, i) => { const cur = i === stepIndex(job); const done = i < stepIndex(job); return (<div key={s} className="flex items-start shrink-0"><div className="flex flex-col items-center w-[62px] min-[560px]:w-[78px]">{cur ? <span className="starburst flex items-center justify-center text-slate-700 font-bold" style={{ background: "#fde047", width: 52, height: 52, fontSize: 16 }}>{i + 1}★</span> : <div className="w-10 h-10 flex items-center justify-center text-base display shadow-[2px_2px_0_rgba(100,116,139,.15)]" style={{ background: done ? "#34d399" : i === stepIndex(job) ? "#ff6b6b" : "#f1f5f9", color: done || i <= stepIndex(job) ? "#fff" : "#94a3b8" }}>{done ? "✓" : i + 1}</div>}<p className={`text-[11px] font-bold mt-1.5 text-center leading-tight ${cur ? "text-amber-600" : "text-slate-500"}`}>{s}{cur ? " ← you are here!" : ""}</p></div>{i < STEPS.length - 1 && <div className="w-3 min-[560px]:w-6 mt-5 shrink-0 border-t-[3px] border-dashed" style={{ borderColor: i < stepIndex(job) ? "#34d399" : "#cbd5e1" }} />}</div>); })}
            </div>
            {(job.status === "refunded" || job.status === "disputed" || job.status === "declined") && <p className="mt-3 text-sm border border-rose-300 bg-rose-50 p-2 font-semibold">⚠ {STATUS_LABEL[job.status]} — {job.status === "refunded" ? "Unreleased credits returned to buyer (simulated)." : job.status === "disputed" ? (job.disputeReason || "Under review below.") : "Declined. No money was ever reserved."}</p>}
            <div className="mt-4"><Speech color="#fef9c3">The brief — this is what everyone agreed to, in writing. ✎</Speech><div className="bubble bg-sky-50 border border-sky-100 p-4"><p className="text-[15px] text-slate-600 leading-relaxed">{job.brief}</p>{job.refsText && <p className="text-[13px] mt-2 text-slate-500">References: {job.refsText}</p>}{job.deliveredNote && <><p className="pill bg-emerald-100 text-emerald-700 px-2 py-0.5 text-[11px] font-bold mt-3 inline-block">Delivered ✓</p><p className="text-sm mt-2 text-slate-600">{job.deliveredNote}</p></>}</div></div>
            {isStaff && <div className="mt-3 flex flex-wrap gap-2" aria-label="Demo controls">
              {job.status === "requested" && <><button className={btn} style={primary} onClick={() => run("accept")} aria-label="Creator accepts request">Creator: Accept</button><button className={btn} style={ghost} onClick={() => run("decline")} aria-label="Creator declines request">Decline</button><span className="flex items-center gap-2"><label htmlFor="counterPrice" className="text-xs font-bold">Counter $</label><input id="counterPrice" type="number" value={counter} onChange={e => setCounter(Number(e.target.value))} className="w-20 px-2 py-1.5 border border-slate-200 mono" /><button className={btn} style={ghost} onClick={() => run("counter", { counterPrice: counter })} aria-label="Counter offer">Counter</button></span></>}
              {job.status === "countered" && <button className={btn} style={primary} onClick={() => run("accept")} aria-label="Buyer accepts counter price">Buyer accepts counter ({money(job.counterPrice ?? job.price)})</button>}
              {job.status === "accepted" && (job.kind === "standard" ? <button className={btn} style={primary} onClick={() => run("reserve")} aria-label="Reserve funds by card pre-authorization">Buyer: Card pre-auth (Reserve)</button> : <button className={btn} style={primary} onClick={() => run("fund")} aria-label="Fund the biller vault">Buyer: Pay via biller (Fund vault)</button>)}
              {(job.status === "reserved" || job.status === "funded") && <button className={btn} style={primary} onClick={() => run("start")} aria-label="Creator starts work">Creator: Start work</button>}
              {job.status === "in_progress" && <><button className={btn} style={primary} onClick={() => run("submitSketch")} aria-label="Submit sketch for approval">Creator: Submit sketch</button>{job.kind === "standard" && <button className={btn} style={ghost} onClick={() => run("deliver")} aria-label="Deliver final work">Creator: Deliver final</button>}{job.kind === "extended" && <button className={btn} style={ghost} onClick={() => run("releaseBlock")} aria-label="Release current weekly block">Release block (≤$50)</button>}<button className={btn} style={danger} onClick={() => run("missDeadline")} aria-label="Simulate missed deadline">⏱ Miss deadline</button></>}
              {job.status === "sketch_review" && <><button className={btn} style={primary} onClick={() => run("approveSketch")} aria-label="Buyer approves sketch">Buyer: Approve sketch ✓</button><button className={btn} style={ghost} onClick={() => run("requestRevision")} aria-label="Request revision">Revision ({job.revisionsUsed}/{job.revisionsTotal})</button></>}
              {job.status === "delivered" && <><button className={btn} style={primary} onClick={() => run("approveDelivery")} aria-label="Buyer confirms delivery and releases funds">Buyer: Confirm — release</button><button className={btn} style={danger} onClick={() => run("dispute", { note: disputeNote })} aria-label="Open a dispute">Open dispute</button></>}
            </div>}
          </div>
        </div>
        <div className="square bg-white border border-slate-200" style={{ borderRadius: 0 }}>
          <div className="bg-amber-50 px-5 py-3 border-b border-amber-100 flex justify-between items-center"><h3 className="condensed text-xl">⏱ Delivery clock</h3><span className="pill mono font-bold text-sm bg-white border border-amber-200 px-3 py-1 text-amber-700">{daysLeft(job.deadline)}</span></div>
          <div className="p-3">
            {job.kind === "standard" ? <p className="text-sm">Standard: deliver within <strong>7 days</strong> of reserve. Miss it → authorization voided, full refund. Money never left the bank.</p> : <>
              <p className="text-sm">Extended: {job.blocksTotal} blocks, max <strong>$50 per block</strong>. Miss a block → buyer recovers every unreleased dollar.</p>
              <div className="mt-3 flex gap-2 flex-wrap">{Array.from({ length: job.blocksTotal }, (_, i) => { const amt = i === job.blocksTotal - 1 ? job.price - (job.blocksTotal - 1) * job.blockAmount : job.blockAmount; return <div key={i} className="border border-slate-200 px-3 py-2 text-center min-w-[84px]" style={{ background: i < job.blocksReleased ? "#34d399" : i === job.blocksReleased ? "#fde047" : "#fff", color: i < job.blocksReleased ? "#fff" : "#64748b" }}><p className="mono font-bold">{money(amt)}</p><p className="text-[10px] font-bold">Block {i + 1} • {i < job.blocksReleased ? "Released" : i === job.blocksReleased ? "Active" : "Locked"}</p></div>; })}</div>
            </>}
          </div>
        </div>
        {(job.status === "delivered" || job.status === "disputed" || job.status === "released") && (
          <div className="square bg-white border border-rose-300" style={{ borderRadius: 0 }}>
            <div className="bg-rose-50 px-5 py-3 border-b border-rose-100"><h3 className="condensed text-xl">⚖ Dispute — brief vs delivered</h3></div>
            <div className="p-3">
              <div className="grid md:grid-cols-2 gap-2 text-sm"><div className="border border-slate-200 p-2"><p className="text-[11px] font-bold bg-amber-50 -m-2 mb-2 px-2 py-1 border-b border-slate-200">Brief said</p><p>{job.brief}</p></div><div className="border border-slate-200 p-2"><p className="text-[11px] font-bold bg-amber-50 -m-2 mb-2 px-2 py-1 border-b border-slate-200">Delivered</p><p>{job.deliveredNote || "Watermarked preview delivered through the platform."}</p></div></div>
              <ul className="mt-3 text-sm space-y-1 list-disc pl-5"><li>Sketch gate: {job.sketchApproved ? <strong className="text-green-700">Approved</strong> : <strong className="text-rose-500">Never approved</strong>}</li><li>Revisions: {job.revisionsUsed} of {job.revisionsTotal} used.</li><li>Rule: not delivered / materially off-brief → refund. Conforms but changed mind → revisions / mediation.</li></ul>
              <div className="mt-3"><label htmlFor="disputeNote" className="text-xs font-bold">Dispute reason</label><textarea id="disputeNote" value={disputeNote} onChange={e => setDisputeNote(e.target.value)} rows={2} className="mt-1 w-full px-3 py-2 border border-slate-200 text-sm bg-white" /></div>
              {isStaff && job.status === "disputed" && <div className="mt-3 flex flex-wrap gap-2"><button className={btn} style={primary} onClick={() => run("resolveRefund")} aria-label="Resolve dispute with refund">Resolve: refund buyer</button><button className={btn} style={ghost} onClick={() => run("resolveRelease")} aria-label="Resolve dispute by releasing to creator">Resolve: release to creator</button></div>}
              {isStaff && job.status !== "disputed" && <button className={btn + " mt-3"} style={danger} onClick={() => run("dispute", { note: disputeNote })} aria-label="Open dispute on this job">Open dispute</button>}
            </div>
          </div>
        )}
      </div>
      <aside className="square lg:col-span-2 min-w-0 bg-white border border-slate-200 lg:sticky lg:top-6 shadow-[5px_5px_0_#dbeafe]" style={{ borderRadius: 0 }}>
        <div className="bg-indigo-50 px-5 py-4"><h3 className="condensed text-xl">Job vault — ledger</h3><p className="mono text-[10px] opacity-80">Job-scoped only • No transfers</p></div>
        <table className="w-full text-sm"><tbody>
          {[["Reserved", reservedAmt, "Card hold"], ["Locked", lockedAmt, "In vault"], ["Milestone Released", job.kind === "extended" ? releasedAmt : 0, "Blocks out"], ["Earned", job.status === "released" ? job.price : 0, "Delivered"], ["Payout → Paid", job.status === "released" ? job.price : 0, "Biller pays"]].map(([label, amt, note]) => (
            <tr key={label as string} className="border-b border-slate-100 odd:bg-white even:bg-violet-50/50"><td className="p-3 text-slate-500"><span className="font-bold">{label}</span><br /><span className="text-[11px] text-neutral-500">{note}</span></td><td className="p-2 text-right mono font-bold text-base">{money(amt as number)}</td></tr>
          ))}
        </tbody></table>
        <div className="p-3"><h4 className="text-xs font-bold border-b border-slate-100 pb-1">Ledger feed</h4><div className="mt-2 space-y-0 max-h-[340px] overflow-y-auto mono text-[11px]">
          {ledger.length === 0 && <p className="py-2 text-neutral-500">No events yet — fund this job.</p>}
          {ledger.map(l => (<div key={l.id} className="py-2 border-b border-dashed border-neutral-300"><p className="font-bold text-[12px] font-sans">{l.label} {l.amount > 0 && <span className="text-[#ff6b6b]">• {money(l.amount)}</span>}</p><p className="text-neutral-500">{l.fromState} → {l.toState} • {new Date(l.createdAt).toLocaleString()}</p>{l.note && <p className="mt-0.5 text-neutral-600 font-sans text-[11px]">{l.note}</p>}</div>))}
        </div></div>
      </aside>
    </div>
  );
}

function WeeklyVault({ data, account, token }: { data: State; account: Account; token: string }) {
  const qc = useQueryClient();
  const lot = data.lots[0];
  const items = lot ? data.items.filter(i => i.lotId === lot.id) : [];
  const totalShares = items.reduce((s, i) => s + i.shares, 0);
  const platformCutPct = 10;
  const [bidder, setBidder] = useState("collector_fox");
  const [bidAmt, setBidAmt] = useState((lot?.currentBid ?? 0) + 10);
  const [simSale, setSimSale] = useState(lot?.currentBid ?? 200);
  const [creatorName, setCreatorName] = useState("Velvetine");
  const [itemTitle, setItemTitle] = useState("");
  const [itemKind, setItemKind] = useState<"picture" | "video">("picture");
  const [door, setDoor] = useState<"fresh" | "salvage">("fresh");
  const [cl, setCl] = useState({ noLikeness: false, noPrivateRefs: false, noExclusiveChar: false, rightsRetained: false });
  const [msg, setMsg] = useState("");
  const picsByCreator = useMemo(() => { const m: Record<string, number> = {}; items.forEach(i => { if (i.kind === "picture") m[i.creatorName] = (m[i.creatorName] ?? 0) + 1; }); return m; }, [items]);
  const vidsByCreator = useMemo(() => { const m: Record<string, number> = {}; items.forEach(i => { if (i.kind === "video") m[i.creatorName] = (m[i.creatorName] ?? 0) + 1; }); return m; }, [items]);
  /* Public bidding is DISABLED on the standalone build (plan §4.1.4): the
     lot stays on display and submissions stay live, but the bid controls
     below render disabled with a paused note — and the server rejects
     placeBid too, so the UI never promises bidding works. */
  const [confirmDelItem, setConfirmDelItem] = useState<string | null>(null);
  const qVaultItem = useMutation({ mutationFn: async (itemId: string) => await api.adminQuarantine({ token, targetType: "vault_item", targetId: itemId, itemTitle: "", note: "", reportId: "" }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["state"] }); setMsg("Item quarantined — hidden from the lot, original preserved in Admin."); }, onError: (e) => setMsg(String(e instanceof Error ? e.message : e)) });
  const dVaultItem = useMutation({ mutationFn: async (itemId: string) => await api.adminDelete({ token, targetType: "vault_item", targetId: itemId, itemTitle: "", reportId: "" }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["state"] }); setMsg("Item permanently deleted."); }, onError: (e) => setMsg(String(e instanceof Error ? e.message : e)) });
  const submitItem = useMutation({ mutationFn: async () => await api.submitAuctionItem({ creatorName, title: itemTitle, kind: itemKind, door, picsThisWeek: picsByCreator[creatorName] ?? 0, vidsThisWeek: vidsByCreator[creatorName] ?? 0, checklist: cl, token }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["state"] }); setMsg("Accepted into this week's lot."); setItemTitle(""); }, onError: (e) => setMsg(String(e)) });
  const pool = Math.max(0, Math.round(simSale * (1 - platformCutPct / 100)));
  const perShare = totalShares > 0 ? pool / totalShares : 0;
  const byCreator: Record<string, { shares: number; titles: string[] }> = {};
  items.forEach(i => { byCreator[i.creatorName] = byCreator[i.creatorName] ?? { shares: 0, titles: [] }; byCreator[i.creatorName]!.shares += i.shares; byCreator[i.creatorName]!.titles.push(i.title); });
  if (!lot) return <p>No lot yet.</p>;
  const inputCls = "mt-1 w-full px-4 py-3 bg-white border border-slate-200 text-sm text-slate-600";
  return (
    <section>
      <div className="bg-violet-50 px-5 py-4 border border-violet-100 flex flex-wrap justify-between gap-2"><h1 className="display text-3xl leading-tight text-slate-700">The Weekly Vault 🎁</h1><span className="mono text-xs bg-white text-slate-700 px-2 py-1 font-bold self-center">Lot #{lot.id.slice(-4).toUpperCase()} • {items.length} items · {totalShares} shares</span></div>
      <p className="text-sm mt-2 bg-white border border-neutral-300 px-3 py-2"><strong>Door 1 — Fresh:</strong> new work. <strong>Door 2 — Salvage:</strong> rejected work, rights-checked only. Winner pays via biller → expiring fingerprinted ZIP.</p>
      <div className="mt-4 grid lg:grid-cols-5 gap-4 items-start">
        <div className="lg:col-span-3 space-y-4 min-w-0">
          <div className="square bg-white border border-slate-200 shadow-[5px_5px_0_#dbeafe]" style={{ borderRadius: 0 }}>
            <div className="bg-violet-50 px-5 py-4 flex flex-wrap justify-between gap-2 border-b border-violet-100"><div><h2 className="condensed text-2xl leading-none">{lot.title}</h2><p className="mono text-[11px] mt-1">{lot.theme} • Reserve {money(lot.reserve)} {lot.currentBid >= lot.reserve ? "• MET ✓" : "• NOT MET"}</p></div><div className="text-right"><p className="mono text-3xl font-bold text-[#fde047] leading-none">{money(lot.currentBid)}</p><p className="mono text-[11px]">High bid: {lot.bidder || "—"}</p></div></div>
            <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="bg-violet-50 border-b border-violet-100 text-left text-[13px] text-slate-500"><th className="p-2 w-10"></th><th className="p-2">Item</th><th className="p-2">Door</th><th className="p-2 text-right">Shares</th></tr></thead><tbody>
              {items.map(i => (<tr key={i.id} className="border-b border-slate-100 odd:bg-white even:bg-pink-50/40"><td className="p-3 text-slate-500">{i.mediaUrl ? ((isVideoMedia(i.mediaUrl) || i.kind === "video") ? <video src={i.mediaUrl} controls preload="metadata" playsInline className="w-28 h-20 object-cover bg-black border border-slate-200" aria-label={`Video preview: ${i.title} by ${i.creatorName}`} /> : <span className="block w-28 h-20 border border-slate-200 overflow-hidden relative"><SafeImg src={i.mediaUrl} alt={`Preview: ${i.title} by ${i.creatorName}`} className="absolute inset-0 w-full h-full object-cover" /></span>) : <div className="w-9 h-9 border border-slate-200 flex items-center justify-center text-white font-bold" style={{ background: i.kind === "video" ? "#38bdf8" : "#f472b6" }}>{i.kind === "video" ? "▶" : "▦"}</div>}</td><td className="p-3 text-slate-500"><span className="font-bold block leading-tight">{i.title}</span><span className="text-xs text-neutral-500">{i.creatorName} • {i.kind}{i.mediaUrl ? ((isVideoMedia(i.mediaUrl) || i.kind === "video") ? " • video preview — press play" : " • preview shown") : ""}</span><span className="mt-1.5 flex flex-wrap gap-1.5"><ReportButton token={token} targetType="vault_item" targetId={i.id} />{(account?.isAdmin || account?.role === "mod") && <><button type="button" disabled={qVaultItem.isPending} onClick={() => qVaultItem.mutate(i.id)} className="btn-playful px-2.5 py-1 bg-slate-700 text-white text-[11px] font-bold disabled:opacity-50" aria-label={`Quarantine vault item ${i.title} (owner)`}>🛡 Quarantine</button>{confirmDelItem === i.id ? <><button type="button" disabled={dVaultItem.isPending} onClick={() => { dVaultItem.mutate(i.id); setConfirmDelItem(null); }} className="btn-playful px-2.5 py-1 bg-rose-500 text-white text-[11px] font-bold disabled:opacity-50" aria-label={`Confirm permanent delete of vault item ${i.title}`}>Yes, delete forever</button><button type="button" onClick={() => setConfirmDelItem(null)} className="btn-playful px-2.5 py-1 bg-white border border-slate-200 text-slate-500 text-[11px] font-bold" aria-label="Cancel deleting this vault item">Keep it</button></> : <button type="button" onClick={() => setConfirmDelItem(i.id)} className="btn-playful px-2.5 py-1 bg-white border border-rose-200 text-rose-500 text-[11px] font-bold" aria-label={`Delete vault item ${i.title} permanently (owner)`}>Delete</button>}</>}</span></td><td className="p-3 text-slate-500"><span className="pill px-2 py-0.5 text-[10px] font-bold text-white" style={{ background: i.door === "salvage" ? "#ff6b6b" : "#34d399" }}>{i.door}</span></td><td className="p-3 text-right mono font-bold text-slate-700">{i.shares}</td></tr>))}
            </tbody></table></div>
            <form className="p-3 border-t border-slate-200 bg-[#fffef9] flex flex-wrap gap-2 items-end" onSubmit={(e) => { e.preventDefault(); }}>
              <div className="flex-1 min-w-[130px]"><label htmlFor="bidder" className="text-xs font-bold">Bidder</label><input id="bidder" value={bidder} onChange={e => setBidder(e.target.value)} className={inputCls} disabled /></div>
              <div><label htmlFor="bidAmt" className="text-xs font-bold">Bid $</label><input id="bidAmt" type="number" value={bidAmt} onChange={e => setBidAmt(Number(e.target.value))} className={inputCls + " mono w-32"} disabled /></div>
              <button type="submit" disabled className="px-5 py-2.5 bg-[#a78bfa] text-white font-bold text-sm border border-slate-200 opacity-50" aria-label="Place bid on this lot (bidding is paused)">Bid →</button>
              <p className="w-full text-[13px] font-semibold text-slate-500">Bidding is paused while the auction model is finalised — this lot is on display only for now.</p>
            </form>
          </div>
          <div className="square bg-white border border-slate-200" style={{ borderRadius: 0 }}>
            <div className="bg-sky-50 px-5 py-3"><h2 className="condensed text-xl">Share-split calculator</h2></div>
            <div className="p-3">
              <p className="text-sm">Picture = <strong>1 share</strong> • Video = <strong>3 shares</strong>. Platform {platformCutPct}% first. Fully-refunded buyer gets $0 from salvage — no double recovery.</p>
              <div className="mt-3 flex items-center gap-3 flex-wrap"><label htmlFor="simSale" className="text-sm font-bold">Sim sale $</label><input id="simSale" type="number" value={simSale} onChange={e => setSimSale(Number(e.target.value))} className="w-32 px-3 py-2 border border-slate-200 mono" /></div>
              <div className="mt-3 bg-emerald-50 border border-emerald-100 px-4 py-3 text-sm flex flex-wrap gap-x-4 font-semibold text-slate-600"><span>Sale {money(simSale)}</span><span>→ platform cut {money(simSale - pool)}</span><span>→ pool <span className="text-amber-500 font-bold">{money(pool)}</span></span><span>÷ {totalShares} = <span className="text-amber-500 font-bold">{money(Math.round(perShare))}/SH</span></span></div>
              <table className="w-full text-sm mt-3 border border-slate-200"><tbody>{Object.entries(byCreator).map(([name, v]) => (<tr key={name} className="border-b border-slate-100 odd:bg-white even:bg-violet-50/50"><td className="p-3 font-bold text-slate-700">{name} <span className="font-normal text-neutral-500 text-xs">({v.shares} sh • {v.titles.length} items)</span></td><td className="p-3 text-right mono font-bold text-slate-700">{money(Math.round(perShare * v.shares))}</td></tr>))}</tbody></table>
            </div>
          </div>
        </div>
        <form className="square lg:col-span-2 min-w-0 bg-white border border-slate-200 shadow-[5px_5px_0_#dbeafe]" style={{ borderRadius: 0 }} onSubmit={(e) => { e.preventDefault(); submitItem.mutate(); }} aria-label="Submit work to the Weekly Vault">
          <div className="bg-pink-50 px-5 py-3 border-b border-pink-100"><h2 className="condensed text-xl">Submit to this week</h2></div>
          <div className="p-5">
            <p className="text-[13px] font-semibold text-slate-500 bg-amber-50 border border-amber-100 p-3">Limit: 10 pictures + 10 videos per creator this week<br />Velvetine: {picsByCreator["Velvetine"] ?? 0}p/{vidsByCreator["Velvetine"] ?? 0}v • Goldleaf: {picsByCreator["Goldleaf"] ?? 0}p/{vidsByCreator["Goldleaf"] ?? 0}v • Mothlight: {picsByCreator["Mothlight Studio"] ?? 0}p/{vidsByCreator["Mothlight Studio"] ?? 0}v</p>
            <div className="mt-3 space-y-3">
              <div><label htmlFor="auCreator" className="text-xs font-bold">Creator</label><select id="auCreator" value={creatorName} onChange={e => setCreatorName(e.target.value)} className={inputCls}>{data.creators.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}</select></div>
              <div><label htmlFor="auTitle" className="text-xs font-bold">Work title</label><input id="auTitle" value={itemTitle} onChange={e => setItemTitle(e.target.value)} className={inputCls} placeholder="e.g. Velvet Dusk — alt version" required /></div>
              <div className="grid grid-cols-2 gap-2">
                <div><label htmlFor="auKind" className="text-xs font-bold">Type</label><select id="auKind" value={itemKind} onChange={e => setItemKind(e.target.value as any)} className={inputCls}><option value="picture">Picture (1 sh)</option><option value="video">Video (3 sh)</option></select></div>
                <div><label htmlFor="auDoor" className="text-xs font-bold">Door</label><select id="auDoor" value={door} onChange={e => setDoor(e.target.value as any)} className={inputCls}><option value="fresh">1 — Fresh</option><option value="salvage">2 — Salvage</option></select></div>
              </div>
              {door === "salvage" && (<fieldset className="border border-rose-300 p-3 bg-rose-50"><legend className="text-xs font-bold px-1 bg-white border border-rose-300">Salvage checklist — all must pass</legend>
                {([["noLikeness", "NO buyer likeness"], ["noPrivateRefs", "NO private refs / personal info"], ["noExclusiveChar", "NOT exclusively purchased"], ["rightsRetained", "I retain resale rights; original job closed & refunded"]] as const).map(([k, label]) => (<label key={k} className="flex items-start gap-2 mt-2 text-sm cursor-pointer font-medium"><input type="checkbox" checked={cl[k]} onChange={e => setCl({ ...cl, [k]: e.target.checked })} className="mt-0.5 w-4 h-4 shrink-0" /><span>{label}</span></label>))}
              </fieldset>)}
            </div>
            {msg && <p className="mt-3 text-sm font-bold border border-slate-200 bg-[#fde047] px-2 py-1.5" role="status">{msg}</p>}
            <button type="submit" disabled={submitItem.isPending} className="mt-4 w-full py-3 bg-[#a78bfa] text-white font-bold text-sm shadow-[3px_3px_0_#ddd6fe] btn-playful" aria-label="Submit item to Weekly Vault">Submit to vault →</button>
          </div>
        </form>
      </div>
    </section>
  );
}
