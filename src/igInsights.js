// The arithmetic behind the Instagram screens, kept apart from the drawing so
// the Analytics page, a post's review and the Content Review cards all judge
// a post the same way.
//
// The one idea running through it: a post is only ever compared with posts
// like it, from around the same time. Reels against reels, and against the
// ones posted nearest to it, because the account in 2019 had a fraction of the
// audience it has now — a 2019 post set against today's is measuring the
// account's growth, not the post.

export const SETTLE_DAYS = 3;     // younger than this and the numbers are still climbing
export const MIN_PEERS = 5;       // fewer comparable posts than this and "typical" is noise
export const PEER_COUNT = 30;     // how many neighbours make up "typical"

export const kindOf = (m) => (m.media_product_type === "REELS" ? "REELS"
  : m.media_product_type === "STORY" ? "STORY" : "FEED");
export const KIND_NOUN = { REELS: "reel", FEED: "post", STORY: "story" };

// Finer than kind, for the format comparison: a carousel and a single photo
// are both "feed", but they don't behave alike.
export function formatOf(m) {
  if (m.media_product_type === "REELS") return "reel";
  if (m.media_product_type === "STORY") return "story";
  if (m.media_type === "CAROUSEL_ALBUM") return "carousel";
  if (m.media_type === "VIDEO") return "video";
  return "photo";
}
export const FORMAT_LABEL = { reel: "Reels", carousel: "Carousels", photo: "Single photos", video: "Feed videos", story: "Stories" };

export const ageDays = (m) => (Date.now() - Date.parse(m.posted_at || 0)) / 86400000;
export const hasNumbers = (m) => m.reach != null;
export const settled = (m) => hasNumbers(m) && ageDays(m) >= SETTLE_DAYS;
export const per = (num, den, scale) => (num != null && den ? (num / den) * scale : null);

export function median(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Share of `values` this one beats, 0..100.
export function percentile(value, values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x));
  if (value == null || !v.length) return null;
  const below = v.filter((x) => x < value).length;
  const equal = v.filter((x) => x === value).length;
  return ((below + equal / 2) / v.length) * 100;
}

export function engagementRate(m) {
  if (!m.reach) return null;
  const interactions = m.total_interactions ?? ((m.likes || 0) + (m.comments || 0) + (m.saved || 0) + (m.shares || 0));
  return (interactions / m.reach) * 100;
}

// The PEER_COUNT settled posts of the same kind posted closest in time.
export function peersFor(post, all, { count = PEER_COUNT, sameFormat = false } = {}) {
  const kind = kindOf(post);
  const fmt = formatOf(post);
  const t = Date.parse(post.posted_at || 0);
  return all
    .filter((m) => m.id !== post.id && kindOf(m) === kind && (!sameFormat || formatOf(m) === fmt) && settled(m))
    .sort((a, b) => Math.abs(Date.parse(a.posted_at) - t) - Math.abs(Date.parse(b.posted_at) - t))
    .slice(0, count);
}

// Reach as a multiple of what its neighbours got: 2.0 means twice the usual.
// This is what lets an old post and a new one be put side by side.
export function relativeReach(post, all) {
  const typical = median(peersFor(post, all, { count: 15 }).map((m) => m.reach));
  return post.reach != null && typical ? post.reach / typical : null;
}

/* ------------------------------ caption reading --------------------------- */

const CTA = /\b(save|share|comment|tag|follow|link in bio|dm|send this|tell us|kerro|jaa|tallenna|kommentoi|seuraa|tägää|linkki biossa)\b/i;
const EMOJI = /\p{Extended_Pictographic}/gu;

export function captionStats(caption) {
  const text = caption || "";
  const firstLine = text.split("\n")[0] || "";
  return {
    length: text.length,
    words: text.trim() ? text.trim().split(/\s+/).length : 0,
    hashtags: (text.match(/#[\p{L}\p{N}_]+/gu) || []).length,
    mentions: (text.match(/@[\w.]+/g) || []).length,
    emoji: (text.match(EMOJI) || []).length,
    question: /\?/.test(text),
    cta: CTA.test(text),
    // Instagram cuts the caption off around here in the feed, behind "more".
    firstLineLength: firstLine.length,
  };
}

/* ------------------------------ best time to post ------------------------- */

export const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const TIME_BLOCKS = [
  { from: 6, to: 9, label: "06–09" },
  { from: 9, to: 12, label: "09–12" },
  { from: 12, to: 15, label: "12–15" },
  { from: 15, to: 18, label: "15–18" },
  { from: 18, to: 21, label: "18–21" },
  { from: 21, to: 24, label: "21–24" },
  { from: 0, to: 6, label: "00–06" },
];
export const dayIndex = (d) => (d.getDay() + 6) % 7; // Monday first
export const blockIndex = (d) => TIME_BLOCKS.findIndex((b) => d.getHours() >= b.from && d.getHours() < b.to);

// Each settled post's relative reach, filed under the weekday and time block
// it went out in (in this device's time zone). Older than two years only if
// there aren't enough recent posts to say anything.
export function postingTimes(all) {
  const usable = all.filter((m) => settled(m) && kindOf(m) !== "STORY");
  const twoYears = usable.filter((m) => ageDays(m) <= 730);
  const pool = twoYears.length >= 40 ? twoYears : usable;
  const cells = Array.from({ length: 7 }, () => TIME_BLOCKS.map(() => []));
  for (const m of pool) {
    const r = relativeReach(m, all);
    if (r == null) continue;
    const d = new Date(m.posted_at);
    const bi = blockIndex(d);
    if (bi >= 0) cells[dayIndex(d)][bi].push({ r, m });
  }
  const grid = cells.map((row) => row.map((list) => ({ n: list.length, value: median(list.map((x) => x.r)), posts: list.map((x) => x.m) })));
  const ranked = [];
  grid.forEach((row, di) => row.forEach((c, bi) => { if (c.n >= 3) ranked.push({ di, bi, ...c }); }));
  ranked.sort((a, b) => b.value - a.value);
  const since = pool.length ? pool.reduce((min, m) => (m.posted_at < min ? m.posted_at : min), pool[0].posted_at) : null;
  return { grid, best: ranked.slice(0, 3), worst: ranked.slice(-2).reverse(), posts: pool.length, since };
}

// How the slot a post went out in usually does, for the post review.
export function slotFor(post, times) {
  const d = new Date(post.posted_at);
  const bi = blockIndex(d);
  if (bi < 0) return null;
  const cell = times.grid[dayIndex(d)][bi];
  return { day: DAY_NAMES[dayIndex(d)], block: TIME_BLOCKS[bi].label, ...cell };
}

/* ------------------------------ format comparison ------------------------- */

// The last 40 settled posts of each format, so every format is judged on its
// recent form rather than on how many years it has been around.
export function formatComparison(all) {
  const groups = {};
  for (const m of all) {
    if (!settled(m) || kindOf(m) === "STORY") continue;
    (groups[formatOf(m)] = groups[formatOf(m)] || []).push(m);
  }
  return Object.entries(groups)
    .map(([fmt, list]) => {
      const recent = [...list].sort((a, b) => b.posted_at.localeCompare(a.posted_at)).slice(0, 40);
      return {
        format: fmt,
        label: FORMAT_LABEL[fmt] || fmt,
        n: recent.length,
        since: recent[recent.length - 1]?.posted_at,
        relReach: median(recent.map((m) => relativeReach(m, all))),
        reach: median(recent.map((m) => m.reach)),
        // Instagram reports 0 views on photos from before it counted them.
        views: median(recent.map((m) => m.views).filter((v) => v > 0)),
        saves: median(recent.map((m) => per(m.saved, m.reach, 100))),
        shares: median(recent.map((m) => per(m.shares, m.reach, 100))),
        engagement: median(recent.map(engagementRate)),
      };
    })
    .filter((g) => g.n >= 3)
    .sort((a, b) => (b.relReach || 0) - (a.relReach || 0));
}

/* ------------------------- matching an upload to a post -------------------- */

const norm = (s) => (s || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

// How likely an Instagram post is the piece someone uploaded: shared words in
// the caption and title, plus a nudge for being recent.
export function matchScore(item, post) {
  const mine = new Set(norm(`${item.title || ""} ${item.caption || ""}`).split(" ").filter((w) => w.length > 3));
  const theirs = new Set(norm(post.caption).split(" ").filter((w) => w.length > 3));
  let shared = 0;
  for (const w of mine) if (theirs.has(w)) shared++;
  // One shared word ("video", "team") is coincidence, not a match.
  const words = shared >= 2 ? shared / Math.min(mine.size, 12) : 0;
  const capMine = norm(item.caption).slice(0, 40);
  const exact = capMine.length > 15 && norm(post.caption).startsWith(capMine) ? 1 : 0;
  const recency = Math.max(0, 1 - ageDays(post) / 120) * 0.15;
  return exact * 2 + words + recency;
}
