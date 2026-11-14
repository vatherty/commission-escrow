import { newInviteCode, uid } from "./auth";
import type { Db, DbHandle } from "./db";
import * as schema from "./schema";
import { SEED_IMG, SEED_VID } from "./seedMedia";

/* Seed content for the standalone port — extracted verbatim from the
   artifact's actions.ts seed sections (samplePosts, SAMPLE_PORTFOLIO_MEDIA,
   MOTHLIGHT_PORTFOLIO, extraCreators, EXTRA_CREATOR_CATS, SAMPLE_ITEM_MEDIA,
   extraCommissions, and the seedPrototype fresh-seed insert block).

   Every value that held a SEED_IMG/SEED_VID data URL in the artifact is
   routed through the caller-supplied `media` mapper, so the CLI seed script
   can rewrite data URLs to `asset:<id>` references backed by object storage
   (CONTRACT.md, media refs). buildSeedData itself never touches storage or
   the database.

   Fresh-seed vs content-upgrade parity (verified against the source):
   the artifact's FRESH insert block already contains everything its
   applyContentUpgrade() backfills onto an older DB — all 5 creators,
   mothlight's 5-item portfolio (incl. "Scene Turntable"), portfolio media
   on all 5 shops, all 8 sample posts, auction items item_1..item_5
   (item_5 included), and demo commissions comm_demo1..comm_demo4 with
   their ledger rows. So one fresh seed built from the fresh path alone
   matches the current live content exactly; no upgrade-only rows exist
   that are missing from the fresh path, and none had to be added. */

export interface SeedData {
  creators: (typeof schema.creators.$inferInsert)[];
  creatorCategories: (typeof schema.creatorCategories.$inferInsert)[];
  commissions: (typeof schema.commissions.$inferInsert)[];
  ledgerEntries: (typeof schema.ledgerEntries.$inferInsert)[];
  auctionLots: (typeof schema.auctionLots.$inferInsert)[];
  auctionItems: (typeof schema.auctionItems.$inferInsert)[];
  posts: (typeof schema.posts.$inferInsert)[];
  postCategories: (typeof schema.postCategories.$inferInsert)[];
}

type MediaMapper = (dataUrl: string) => string;

/** Raw portfolio media maps, keyed by portfolio item title (source:
    SAMPLE_PORTFOLIO_MEDIA). Values are data URLs; callers map them. */
const SAMPLE_PORTFOLIO_MEDIA: Record<string, Record<string, string>> = {
  velvetine: { "Candlelit Study": SEED_IMG.velv_candle ?? "", "Thorn Garden": SEED_IMG.velv_thorn ?? "", "Masquerade Pair": SEED_IMG.velv_pair ?? "", "Velvet Dusk": SEED_IMG.velv_dusk ?? "" },
  mothlight: { "Lantern Moth": SEED_IMG.moth_lantern ?? "", "Fern Knight": SEED_IMG.moth_fern ?? "", "Cloud Familiar": SEED_IMG.moth_cloud ?? "", "Night Market": SEED_IMG.moth_market ?? "", "Scene Turntable": SEED_VID.turntable ?? "" },
  goldleaf: { "Gilded Hour": SEED_IMG.gold_hour ?? "", "Pearl Editorial": SEED_IMG.gold_pearl ?? "", "Amethyst Cover": SEED_IMG.gold_amethyst ?? "", "Silk & Gold": SEED_IMG.gold_silk ?? "" },
  echovale: { "Voice Reel — Heroes & Villains": SEED_IMG.echo_hero ?? "", "Cozy Wind-Down Session": SEED_IMG.echo_asmr ?? "", "Character Voices — Set of Six": SEED_IMG.echo_chars ?? "", "Audiobook Narration Sample": SEED_IMG.echo_narr ?? "" },
  inkbound: { "Novel Opening — Moonlit Court": SEED_IMG.ink_novel ?? "", "Poem Set — Harvest Songs": SEED_IMG.ink_poetry ?? "", "World Lore — The Sunken Roads": SEED_IMG.ink_world ?? "", "Love Letters, Ghostwritten": SEED_IMG.ink_letters ?? "" },
};

const MOTHLIGHT_PORTFOLIO = [{ title: "Lantern Moth", kind: "Illustration", hue: 170 }, { title: "Fern Knight", kind: "Design sheet", hue: 140 }, { title: "Cloud Familiar", kind: "Icon", hue: 190 }, { title: "Night Market", kind: "Scene", hue: 210 }, { title: "Scene Turntable", kind: "Video preview", hue: 190 }];

const EXTRA_CREATOR_CATS: { creatorId: string; category: string }[] = [
  { creatorId: "echovale", category: "Voice & Audio" },
  { creatorId: "echovale", category: "Music & Sound" },
  { creatorId: "echovale", category: "VTuber & Stream Assets" },
  { creatorId: "echovale", category: "Live Sessions" },
  { creatorId: "inkbound", category: "Writing & Stories" },
  { creatorId: "inkbound", category: "Fantasy" },
  { creatorId: "inkbound", category: "Romance" },
  { creatorId: "inkbound", category: "Horror & Dark" },
];

/** Vault lot media, keyed by seeded item id (source: SAMPLE_ITEM_MEDIA). */
const SAMPLE_ITEM_MEDIA: Record<string, string> = {
  item_1: SEED_IMG.velv_thorn ?? "",
  item_2: SEED_VID.masquerade ?? "",
  item_3: SEED_IMG.gold_pearl ?? "",
  item_4: SEED_VID.lantern ?? "",
  item_5: SEED_IMG.ink_novel ?? "",
};

export function buildSeedData(now: Date, media: MediaMapper): SeedData {
  /* Empty strings stay empty (the artifact's `?? ""` fallbacks); only real
     data URLs go through the mapper, so a collecting mapper never records
     a "" and an asset mapper never tries to store one. */
  const m = (v: string): string => (v ? media(v) : v);
  const mappedPortfolio = (rec: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, m(v)]));

  const h = 3600 * 1000; const d = 24 * h;

  /* ---- Sample offer posts (source: samplePosts) ---- */
  const posts: SeedData["posts"] = [
    { id: "post_moth_turntable", creatorId: "mothlight", title: "Watch a scene commission move — 3D turntable preview", body: "This is how every scene commission starts: I build your character's world in 3D and spin it, so we can pick the perfect angle together before the final render. Press play — that's a real clip of the lantern-moth scene setup. Want your OC standing in a place like this?", priceNote: "Scenes from $210 · preview is free", imageUrl: "", videoUrl: m(SEED_VID.turntable ?? ""), createdAt: new Date(now.getTime() - 2 * h) },
    { id: "post_velv_slots", creatorId: "velvetine", title: "Portrait slots open — 3 left this week", body: "Opening three portrait slots! Bust or half-body, candlelit and romantic as always. Every piece starts with a sketch you approve before anything is captured — tell me about your character and I'll bring the mood.", priceNote: "$85 per bust · 3 slots open", imageUrl: m(SEED_IMG.velv_candle ?? ""), videoUrl: "", createdAt: new Date(now.getTime() - 5 * h) },
    { id: "post_echo_reel", creatorId: "echovale", title: "Voice commissions open — hear the reel, pick your character", body: "New shop, familiar voices! I record character voice packs, narration and VTuber voice lines from my little treated booth. The reel on my page covers heroes, villains and one very smug shopkeeper. Tell me about your character and I'll send a free 10-second test line before you commit.", priceNote: "$70 character voice pack · 4 slots", imageUrl: m(SEED_IMG.echo_hero ?? ""), videoUrl: "", createdAt: new Date(now.getTime() - 9 * h) },
    { id: "post_moth_scene", creatorId: "mothlight", title: "Now offering full fantasy scene commissions", body: "Your OC, placed in a world that feels lived-in — lantern-lit forests, night markets, moth familiars and all. I build the scene in 3D first so we can play with angles before the final render. Design sheets still available too!", priceNote: "Scenes from $210 · design sheets $180", imageUrl: m(SEED_IMG.moth_market ?? ""), videoUrl: "", createdAt: new Date(now.getTime() - 1 * d - 3 * h) },
    { id: "post_ink_story", creatorId: "inkbound", title: "Custom short stories — your character, my words", body: "Give me your original character and a mood — longing, adventure, gentle horror — and I'll write them a story that's theirs alone. Flash fiction in the standard 7 days; longer tales run as extended jobs so you read a chapter a week as it's funded.", priceNote: "Flash fiction $40 · 3 slots open", imageUrl: m(SEED_IMG.ink_novel ?? ""), videoUrl: "", createdAt: new Date(now.getTime() - 1 * d - 8 * h) },
    { id: "post_gold_cosplay", creatorId: "goldleaf", title: "One cosplay photo set slot — waitlist gets first pick", body: "A rare opening: one full cosplay photo set this month, gilded editorial styling, jewellery detail included. My waitlist hears first, so if you're on it, check your inbox — the slot goes to whoever confirms first.", priceNote: "$120 per set · 1 slot", imageUrl: m(SEED_IMG.gold_pearl ?? ""), videoUrl: "", createdAt: new Date(now.getTime() - 2 * d - 6 * h) },
    { id: "post_velv_weekend", creatorId: "velvetine", title: "Weekend only: couples portraits, two characters one price", body: "For this weekend only, couples portraits are priced as a single character plus a little extra instead of double. Masquerade, candlelight, dramatic longing — you know the drill. Offer ends Sunday night.", priceNote: "$150 for the pair · ends Sunday", imageUrl: m(SEED_IMG.velv_pair ?? ""), videoUrl: "", createdAt: new Date(now.getTime() - 3 * d - 2 * h) },
    { id: "post_moth_icons", creatorId: "mothlight", title: "Animated icon commissions are back", body: "Little looping icons and GIFs of your character — blinking, sparkling, moth optional but encouraged. Perfect for profiles and stream overlays. Quick turnaround, usually inside the standard 7 days.", priceNote: "$55 per icon · animated", imageUrl: m(SEED_IMG.moth_cloud ?? ""), videoUrl: "", createdAt: new Date(now.getTime() - 4 * d - 7 * h) },
  ];
  const postCategories: SeedData["postCategories"] = [
    { postId: "post_moth_turntable", category: "3D Art & Renders" },
    { postId: "post_moth_turntable", category: "Fantasy" },
    { postId: "post_moth_turntable", category: "Video & Short Clips" },
    { postId: "post_velv_slots", category: "Portraits" },
    { postId: "post_velv_slots", category: "Digital Illustration" },
    { postId: "post_velv_slots", category: "Pin-up & Glamour" },
    { postId: "post_echo_reel", category: "Voice & Audio" },
    { postId: "post_echo_reel", category: "Character Design & OCs" },
    { postId: "post_moth_scene", category: "3D Art & Renders" },
    { postId: "post_moth_scene", category: "Fantasy" },
    { postId: "post_moth_scene", category: "Landscapes & Scenes" },
    { postId: "post_ink_story", category: "Writing & Stories" },
    { postId: "post_ink_story", category: "Fantasy" },
    { postId: "post_gold_cosplay", category: "Photography" },
    { postId: "post_gold_cosplay", category: "Cosplay" },
    { postId: "post_gold_cosplay", category: "Portraits" },
    { postId: "post_velv_weekend", category: "Portraits" },
    { postId: "post_velv_weekend", category: "Character Design & OCs" },
    { postId: "post_moth_icons", category: "Animation & GIFs" },
    { postId: "post_moth_icons", category: "Fantasy" },
  ];

  /* ---- Creators: the seedPrototype fresh insert (3 shops) plus
     extraCreators() (echovale, inkbound), exactly as the source composes
     them with the spread. ---- */
  const creators: SeedData["creators"] = [
    { id: "velvetine", name: "Velvetine", handle: "@velvetine", tagline: "Dark romantic character portraits", accent: "#e05260", bio: "Original-character portraits with candlelit, gothic-romance mood. Every commission starts with a sketch gate — you approve the direction before a dollar moves.", status: "open", turnaround: "Standard: within 7 days · Extended: weekly blocks", pricesJson: JSON.stringify([{ label: "Bust portrait", price: 85 }, { label: "Half-body, detailed", price: 150 }, { label: "Full-body scene", price: 240 }, { label: "Extra character", price: 60 }]), willDoJson: JSON.stringify(["Original characters", "Fantasy & gothic romance", "Couples portraits", "Tasteful glamour & pin-up style"]), wontDoJson: JSON.stringify(["Real people without consent", "Characters owned by someone else without permission", "Rush jobs under 48h", "Work for resale as-is"]), portfolioJson: JSON.stringify([{ title: "Candlelit Study", kind: "Portrait", hue: 350 }, { title: "Thorn Garden", kind: "Half-body", hue: 330 }, { title: "Masquerade Pair", kind: "Couples", hue: 280 }, { title: "Velvet Dusk", kind: "Scene", hue: 20 }]), portfolioImagesJson: JSON.stringify(mappedPortfolio(SAMPLE_PORTFOLIO_MEDIA.velvetine)), bgColor: "#fff5f5", panelColor: "#ffffff", accent2: "#f9a8d4", headingColor: "#7f1d2d", bodyColor: "#57534e" },
    { id: "mothlight", name: "Mothlight Studio", handle: "@mothlight.studio", tagline: "Dreamy fantasy OC art & character design", accent: "#2ec4b6", bio: "Soft, luminous fantasy illustrations and character design sheets. I love inventing outfits, familiars and little worlds around your OC.", status: "open", turnaround: "Standard: within 7 days · Extended: weekly blocks", pricesJson: JSON.stringify([{ label: "Character design sheet", price: 180 }, { label: "Chibi / icon", price: 55 }, { label: "Full illustration", price: 210 }, { label: "Reference sheet add-on", price: 45 }]), willDoJson: JSON.stringify(["Original characters & design", "Fantasy, moths, forests, magic", "Anthro characters", "Outfit design"]), wontDoJson: JSON.stringify(["Photoreal people", "Logos / branding", "Unlimited revisions", "Exclusive buyout without a buyout fee"]), portfolioJson: JSON.stringify(MOTHLIGHT_PORTFOLIO), portfolioImagesJson: JSON.stringify(mappedPortfolio(SAMPLE_PORTFOLIO_MEDIA.mothlight)), bgColor: "#f0fdfa", panelColor: "#ffffff", accent2: "#7dd3fc", headingColor: "#134e4a", bodyColor: "#475569" },
    { id: "goldleaf", name: "Goldleaf", handle: "@goldleaf", tagline: "Elegant glamour portraits, gilded detail", accent: "#9b7ed9", bio: "Gilded, editorial-style glamour portraits. Clean lines, rich fabric, jewellery that actually sparkles. Waitlist most months — the vault clock keeps us both honest.", status: "waitlist", turnaround: "Waitlist · Extended commissions preferred", pricesJson: JSON.stringify([{ label: "Glamour bust", price: 120 }, { label: "Editorial full-body", price: 260 }, { label: "Cover-style illustration", price: 320 }]), willDoJson: JSON.stringify(["Glamour & editorial portraits", "Fashion & jewellery detail", "Original characters", "Book-cover style work"]), wontDoJson: JSON.stringify(["Rush delivery", "Real-person likeness without verified consent", "NFT minting of delivered work"]), portfolioJson: JSON.stringify([{ title: "Gilded Hour", kind: "Portrait", hue: 260 }, { title: "Pearl Editorial", kind: "Full-body", hue: 45 }, { title: "Amethyst Cover", kind: "Cover", hue: 285 }, { title: "Silk & Gold", kind: "Scene", hue: 35 }]), portfolioImagesJson: JSON.stringify(mappedPortfolio(SAMPLE_PORTFOLIO_MEDIA.goldleaf)), bgColor: "#faf5ff", panelColor: "#ffffff", accent2: "#facc15", headingColor: "#4c1d95", bodyColor: "#57534e" },
    { id: "echovale", name: "Echo Vale", handle: "@echovale", tagline: "Character voices, narration & cozy audio", accent: "#38bdf8", bio: "Voice actor with a little treated booth and a big range — heroes, villains, smug shopkeepers, soft narrators. Every job starts with a free 10-second test line so you hear your character before any money moves.", status: "open", turnaround: "Standard: within 7 days · Extended: weekly blocks", pricesJson: JSON.stringify([{ label: "Character voice pack (10 lines)", price: 70 }, { label: "Narration, per 500 words", price: 45 }, { label: "VTuber voice pack", price: 95 }, { label: "Live directed session (1h)", price: 90 }]), willDoJson: JSON.stringify(["Original characters & fan OCs", "Narration & audiobook chapters", "VTuber & stream alerts", "Cozy wind-down / ASMR-style audio (non-explicit)"]), wontDoJson: JSON.stringify(["Impersonating real people or public figures", "Political ad reads", "Undisclosed AI-training datasets", "Rush jobs under 24h"]), portfolioJson: JSON.stringify([{ title: "Voice Reel — Heroes & Villains", kind: "Audio reel", hue: 205 }, { title: "Cozy Wind-Down Session", kind: "Audio session", hue: 290 }, { title: "Character Voices — Set of Six", kind: "Voice pack", hue: 160 }, { title: "Audiobook Narration Sample", kind: "Narration", hue: 40 }]), pfpUrl: m(SEED_IMG.echo_pfp ?? ""), bannerUrl: m(SEED_IMG.echo_banner ?? ""), bgColor: "#f0f9ff", panelColor: "#ffffff", accent2: "#a78bfa", headingColor: "#0c4a6e", bodyColor: "#475569", portfolioImagesJson: JSON.stringify(mappedPortfolio(SAMPLE_PORTFOLIO_MEDIA.echovale)) },
    { id: "inkbound", name: "Inkbound", handle: "@inkbound", tagline: "Short stories, poems & world lore, written for your characters", accent: "#fb923c", bio: "Writer for hire — flash fiction, short stories, poems and lore pages starring YOUR characters. You bring the character and the mood; I bring the sentences. Drafts arrive in the platform so the brief, the sketch-equivalent (an outline you approve), and the final text all live in one place.", status: "open", turnaround: "Standard: within 7 days · Extended: weekly blocks (a chapter a week)", pricesJson: JSON.stringify([{ label: "Flash fiction (~1,000 words)", price: 40 }, { label: "Short story (~3,000 words)", price: 110 }, { label: "Poem set (3 poems)", price: 30 }, { label: "World lore page", price: 75 }]), willDoJson: JSON.stringify(["Original characters & worlds", "Fantasy, romance & gentle horror", "Character backstories & lore bibles", "Ghostwritten letters in character"]), wontDoJson: JSON.stringify(["Academic work / homework", "Real people without consent", "Plots built on someone else's copyrighted story beats-for-beats", "Same-day rush"]), portfolioJson: JSON.stringify([{ title: "Novel Opening — Moonlit Court", kind: "Story opening", hue: 265 }, { title: "Poem Set — Harvest Songs", kind: "Poems", hue: 30 }, { title: "World Lore — The Sunken Roads", kind: "Lore page", hue: 165 }, { title: "Love Letters, Ghostwritten", kind: "Letters", hue: 330 }]), pfpUrl: m(SEED_IMG.ink_pfp ?? ""), bannerUrl: m(SEED_IMG.ink_banner ?? ""), bgColor: "#fff7ed", panelColor: "#ffffff", accent2: "#f472b6", headingColor: "#7c2d12", bodyColor: "#57534e", portfolioImagesJson: JSON.stringify(mappedPortfolio(SAMPLE_PORTFOLIO_MEDIA.inkbound)) },
  ];

  const creatorCategories: SeedData["creatorCategories"] = [
    { creatorId: "velvetine", category: "Digital Illustration" },
    { creatorId: "velvetine", category: "Pin-up & Glamour" },
    { creatorId: "velvetine", category: "Portraits" },
    { creatorId: "velvetine", category: "Character Design & OCs" },
    { creatorId: "mothlight", category: "3D Art & Renders" },
    { creatorId: "mothlight", category: "Fantasy" },
    { creatorId: "mothlight", category: "Animation & GIFs" },
    { creatorId: "goldleaf", category: "Photography" },
    { creatorId: "goldleaf", category: "Cosplay" },
    { creatorId: "goldleaf", category: "Portraits" },
    ...EXTRA_CREATOR_CATS,
  ];

  /* ---- Commissions: seedPrototype's demo1/demo2 plus extraCommissions()
     (demo3 Delivered, demo4 Released), composed exactly as the source. ---- */
  const deadline = new Date(now.getTime() + 3 * d);
  const commissions: SeedData["commissions"] = [
    { id: "comm_demo1", creatorId: "velvetine", buyerName: "Alex R.", title: "Original character portrait — tavern scene", brief: "Half-body portrait of my original character Mara, a travelling bard, seated in a candlelit tavern. Warm light, lute on her back, mischievous smile. Deep reds and golds to match Velvetine's style.", refsText: "Character sheet v3 (shared link), tavern moodboard — candlelight, dark wood, red velvet.", budget: 180, price: 180, kind: "extended", rail: "vault", status: "in_progress", deadline, sketchApproved: 1, revisionsUsed: 0, revisionsTotal: 2, blocksTotal: 4, blocksReleased: 1, blockAmount: 50 },
    { id: "comm_demo2", creatorId: "mothlight", buyerName: "Jordan T.", title: "Character design sheet — moth familiar", brief: "Design sheet for a forest guardian character with a giant lantern-moth familiar. Front view, outfit breakdown, colour palette.", refsText: "Pinterest board shared; palette: sage, cream, lantern gold.", budget: 180, price: 180, kind: "standard", rail: "reserve", status: "requested", deadline: null, sketchApproved: 0, revisionsTotal: 2, blocksTotal: 1, blocksReleased: 0, blockAmount: 50 },
    { id: "comm_demo3", creatorId: "goldleaf", buyerName: "Sam K.", title: "Glamour bust portrait — pearl theme", brief: "Editorial glamour bust of my character Odette, pearl jewellery, soft studio light, gold accents to match Goldleaf's Pearl Editorial. Delivered piece should match the approved sketch's pose and palette.", refsText: "Pearl Editorial (portfolio) as the style reference; character sheet shared in chat.", budget: 120, price: 120, kind: "standard", rail: "reserve", status: "delivered", deadline: new Date(now.getTime() + 2 * d), sketchApproved: 1, revisionsUsed: 1, revisionsTotal: 2, deliveredNote: "Final files delivered through the platform — watermarked preview shown, full files unlock on release.", blocksTotal: 1, blocksReleased: 0, blockAmount: 50, createdAt: new Date(now.getTime() - 1 * d) },
    { id: "comm_demo4", creatorId: "mothlight", buyerName: "Priya N.", title: "Chibi icon — cloud familiar", brief: "Chibi icon of my sky-pirate character with her little cloud familiar, blinking loop if possible, transparent background for stream overlays.", refsText: "Character ref sheet v2; palette: sky blue, cream, lantern gold.", budget: 55, price: 55, kind: "standard", rail: "reserve", status: "released", deadline: new Date(now.getTime() - 4 * d), sketchApproved: 1, revisionsUsed: 0, revisionsTotal: 2, deliveredNote: "Final files delivered through the platform — watermarked preview shown, full files unlock on release.", blocksTotal: 1, blocksReleased: 0, blockAmount: 50, createdAt: new Date(now.getTime() - 5 * d) },
  ];

  const ledgerEntries: SeedData["ledgerEntries"] = [
    { commissionId: "comm_demo1", label: "Buyer paid via biller (simulated)", fromState: "—", toState: "Locked", amount: 180, note: "Fake processor: payment captured into biller pending balance. Platform holds no funds." },
    { commissionId: "comm_demo1", label: "Sketch approved by buyer", fromState: "Locked", toState: "Locked", amount: 0, note: "Sketch gate passed — direction locked before full render." },
    { commissionId: "comm_demo1", label: "Block 1 released (week 1)", fromState: "Locked", toState: "Milestone Released", amount: 50, note: "Weekly block cap $50 applied. Next block unlocks after progress check." },
    { commissionId: "comm_demo3", label: "Card pre-authorization placed (simulated)", fromState: "—", toState: "Reserved", amount: 120, note: "Fake processor: buyer's bank freezes the amount. Nothing captured yet." },
    { commissionId: "comm_demo3", label: "Sketch approved by buyer", fromState: "Reserved", toState: "Reserved", amount: 0, note: "Sketch gate passed — pose and palette locked before the final render." },
    { commissionId: "comm_demo3", label: "Delivered — awaiting buyer confirmation", fromState: "Reserved", toState: "Reserved", amount: 0, note: "Creator delivered. The $120 hold captures only when the buyer confirms (or the review window passes)." },
    { commissionId: "comm_demo4", label: "Card pre-authorization placed (simulated)", fromState: "—", toState: "Reserved", amount: 55, note: "Fake processor: buyer's bank freezes the amount. Nothing captured yet." },
    { commissionId: "comm_demo4", label: "Sketch approved by buyer", fromState: "Reserved", toState: "Reserved", amount: 0, note: "Sketch gate passed." },
    { commissionId: "comm_demo4", label: "Authorization captured on delivery", fromState: "Reserved", toState: "Earned", amount: 55, note: "Buyer confirmed delivery. Creator earnings move to Payout Pending at the biller, then Paid on the biller's schedule." },
  ];

  /* ---- Weekly Vault lot + items (item_5 is part of the source's FRESH
     insert block, not upgrade-only). ---- */
  const auctionLots: SeedData["auctionLots"] = [
    { id: "lot_week1", title: "Weekly Vault — Drop #1", theme: "Gothic Romance & Gilded Glamour", reserve: 120, currentBid: 145, bidder: "collector_fox", status: "open" },
  ];
  const auctionItems: SeedData["auctionItems"] = [
    { id: "item_1", lotId: "lot_week1", creatorName: "Velvetine", title: "Thorn Garden — alt version", kind: "picture", door: "fresh", shares: 1, mediaUrl: m(SAMPLE_ITEM_MEDIA.item_1 ?? ""), status: "accepted", checklistJson: "{}" },
    { id: "item_2", lotId: "lot_week1", creatorName: "Velvetine", title: "Masquerade process video", kind: "video", door: "fresh", shares: 3, mediaUrl: m(SAMPLE_ITEM_MEDIA.item_2 ?? ""), status: "accepted", checklistJson: "{}" },
    { id: "item_3", lotId: "lot_week1", creatorName: "Goldleaf", title: "Pearl Editorial — rejected commission, resellable", kind: "picture", door: "salvage", shares: 1, mediaUrl: m(SAMPLE_ITEM_MEDIA.item_3 ?? ""), status: "accepted", checklistJson: JSON.stringify({ noLikeness: true, noPrivateRefs: true, noExclusiveChar: true, rightsRetained: true }) },
    { id: "item_4", lotId: "lot_week1", creatorName: "Mothlight Studio", title: "Lantern Moth — timelapse", kind: "video", door: "fresh", shares: 3, mediaUrl: m(SAMPLE_ITEM_MEDIA.item_4 ?? ""), status: "accepted", checklistJson: "{}" },
    { id: "item_5", lotId: "lot_week1", creatorName: "Inkbound", title: "Moonlit Court — rejected cover draft, resellable", kind: "picture", door: "salvage", shares: 1, mediaUrl: m(SAMPLE_ITEM_MEDIA.item_5 ?? ""), status: "accepted", checklistJson: JSON.stringify({ noLikeness: true, noPrivateRefs: true, noExclusiveChar: true, rightsRetained: true }) },
  ];

  return { creators, creatorCategories, commissions, ledgerEntries, auctionLots, auctionItems, posts, postCategories };
}

/** Launch invite set (source: ensureLaunchInvites in actions.ts): tops the
    invite_codes table up to exactly 10 codes, maxUses 1 each, createdBy
    "launch-seed". Rows are never deleted by sign-up (uses are counted on
    the row), so once 10 codes exist this is a no-op — and codes generated
    by hand (e.g. via Admin) count toward the 10.
    Accepts the Drizzle db, a DbHandle, or a transaction handle (anything
    with select/insert over the schema), so the CLI can run it inside the
    seed transaction. Returns the codes it created so the caller can print
    them exactly once. */
export async function ensureLaunchInvites(db: Db | DbHandle): Promise<{ created: number; codes: string[] }> {
  const isHandle = (db as DbHandle).kind !== undefined && typeof (db as DbHandle).execSql === "function";
  const d = (isHandle ? (db as DbHandle).db : db) as Db;
  const existing = await d.select().from(schema.inviteCodes);
  const missing = Math.max(0, 10 - existing.length);
  const codes: string[] = [];
  for (let i = 0; i < missing; i++) {
    const code = newInviteCode();
    await d.insert(schema.inviteCodes).values({ id: uid("inv"), code, maxUses: 1, usesCount: 0, createdBy: "launch-seed", disabled: 0 });
    codes.push(code);
  }
  return { created: codes.length, codes };
}
