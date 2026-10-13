// The "what should we make" arithmetic: themes, series, hooks, follower
// conversion, experiments, retention patterns, people and the monthly brief.
// All of it is plain statistics over the team's own posts — no paid service.
//
// Everything is judged by relative reach (reach next to posts of the same
// kind from around the same time, see igInsights.js), so a 2019 post and
// today's can sit in the same list.
import { kindOf, formatOf, FORMAT_LABEL, settled, median, per, relativeReach, postingTimes, DAY_NAMES, TIME_BLOCKS } from "./igInsights";

const MIN_GROUP = 3;

// Words that say nothing about a post's subject, Finnish and English.
const STOP = new Set(`sekä aikana sitä ollaan koska vaan jotta ennen jälkeen tänään täällä siellä tästä siitä tässä siinä meillä teillä heidän olemme olette joten kuten aina paljon lisää kaikkea jotain joku mitään mikään tämän sen sinun minun hänen teidän niiden ihan tosi todella aivan lähes noin yksi kaksi kolme ensi viime vuoden vuonna päivä päivän viikon illan kaikki kaikkien sinne tänne niitä näitä joita jonka joiden niin kuin tule tulee tulla tuli olla olisi oisi olis voisi voidaan saada saatte haluan halua ja on ei se että kun niin mutta tai jos kuin myös vain sitten nyt jo vielä kanssa meidän meille meitä me te he hän sinä minä mä mun sun sä tää toi tämä tuo nämä noi ne ole oli olla ollut olen olet olemme ovat oot voi voit saa tule tuu tervetuloa kaikki kaikille joka jossa jotka mitä miten miksi mikä missä milloin mukaan kautta asti alkaen klo the and for you your with this that are was were have has our from will what when where who why how can all not but just get got its it's into out about more some than then them they there their here also very really dont don't i'm you're we're let's lets www http https com`.split(/\s+/));

export const wordsOf = (text) => (text || "").toLowerCase()
  .replace(/https?:\/\/\S+/g, " ")
  .replace(/[#@][\p{L}\p{N}_.]+/gu, " ")
  .split(/[^\p{L}\p{N}]+/u)
  .filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));
export const hashtagsOf = (text) => [...new Set(((text || "").toLowerCase().match(/#[\p{L}\p{N}_]+/gu) || []))];

const usable = (media) => media.filter((m) => settled(m) && kindOf(m) !== "STORY");
const relCache = new WeakMap();
// relativeReach is the expensive bit; every view here asks for it per post.
export function rel(m, media) {
  let byPost = relCache.get(media);
  if (!byPost) { byPost = new Map(); relCache.set(media, byPost); }
  if (!byPost.has(m.id)) byPost.set(m.id, relativeReach(m, media));
  return byPost.get(m.id);
}

function groupStats(posts, media) {
  const reels = posts.filter((m) => kindOf(m) === "REELS");
  return {
    n: posts.length,
    rel: median(posts.map((m) => rel(m, media))),
    saves: median(posts.map((m) => per(m.saved, m.reach, 100))),
    shares: median(posts.map((m) => per(m.shares, m.reach, 100))),
    watch: reels.length >= MIN_GROUP ? median(reels.map((m) => (m.avg_watch_time_ms ? m.avg_watch_time_ms / 1000 : null))) : null,
  };
}

/* ---------------------------------- themes --------------------------------- */
// A theme is a name plus words that mark a post as being about it, and any
// posts the team tagged or untagged by hand. board.igThemes:
//   { list: [{ id, name, words: [...] }], manual: { [mediaId]: [themeId] }, off: { [mediaId]: [themeId] } }

export function themesOf(post, themes) {
  const list = themes?.list || [];
  const manual = new Set(themes?.manual?.[post.id] || []);
  const off = new Set(themes?.off?.[post.id] || []);
  const text = `${post.caption || ""}`.toLowerCase();
  return list.filter((t) => manual.has(t.id) || (!off.has(t.id) && (t.words || []).some((w) => w && text.includes(w.toLowerCase())))).map((t) => t.id);
}

// Finnish puts its prepositions on the end of the word (koulu, koulun,
// koulussa, jumala, jumalan), so words are grouped by their first five
// letters. The same five letters are the theme's marker: found inside a
// caption, they catch every form of the word.
export function stemOf(word) {
  const w = word.replace(/^#/, "");
  return w.length <= 5 ? w : w.slice(0, 5);
}

// Words and hashtags that recur across a real share of posts — common enough
// to be a subject, not so common they're filler — minus the account's own name.
export function suggestThemes(media, themes, { brand = "", limit = 14 } = {}) {
  const posts = usable(media);
  if (!posts.length) return [];
  const taken = (themes?.list || []).flatMap((t) => (t.words || []).map((w) => w.toLowerCase()));
  const brandStem = brand.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "").slice(0, 8);
  const groups = new Map(); // stem -> { n, forms: Map(form -> count) }
  for (const m of posts) {
    const stems = new Map();
    for (const w of [...wordsOf(m.caption), ...hashtagsOf(m.caption).map((h) => h.slice(1))]) {
      const st = stemOf(w);
      if (!stems.has(st)) stems.set(st, w);
    }
    for (const [st, form] of stems) {
      const g = groups.get(st) || { n: 0, forms: new Map() };
      g.n++;
      g.forms.set(form, (g.forms.get(form) || 0) + 1);
      groups.set(st, g);
    }
  }
  const max = posts.length * 0.35;
  return [...groups.entries()]
    .filter(([st, g]) => g.n >= 4 && g.n <= max && st.length >= 4 && !STOP.has(st)
      && !(brandStem.length >= 5 && (st.includes(brandStem.slice(0, 6)) || brandStem.includes(st)))
      && !taken.some((t) => t.includes(st) || st.includes(t)))
    .map(([st, g]) => {
      const name = [...g.forms.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const matching = posts.filter((m) => (m.caption || "").toLowerCase().includes(st));
      return { word: st, name, n: g.n, rel: median(matching.map((m) => rel(m, media))) };
    })
    .sort((a, b) => b.n - a.n)
    .slice(0, limit);
}

export function themeStats(media, themes) {
  const posts = usable(media);
  const all = groupStats(posts, media);
  return (themes?.list || []).map((t) => {
    const inTheme = posts.filter((m) => themesOf(m, themes).includes(t.id));
    return { ...t, ...groupStats(inTheme, media), posts: inTheme, vsAll: all.rel ? median(inTheme.map((m) => rel(m, media))) / all.rel : null };
  }).sort((a, b) => (b.n >= MIN_GROUP) - (a.n >= MIN_GROUP) || (b.rel || 0) - (a.rel || 0));
}

/* ---------------------------------- series --------------------------------- */
// A recurring format the team runs: the same opening words or a hashtag of
// its own, on three or more posts spread over at least three weeks.
const opening = (caption) => wordsOf((caption || "").split("\n")[0]).slice(0, 2).join(" ");

export function detectSeries(media, hidden = []) {
  const posts = usable(media);
  const keys = new Map();
  const tagShare = new Map();
  for (const m of posts) for (const h of hashtagsOf(m.caption)) tagShare.set(h, (tagShare.get(h) || 0) + 1);
  for (const m of posts) {
    const found = new Set();
    const start = opening(m.caption);
    if (start.includes(" ")) found.add(`start:${start}`);
    for (const h of hashtagsOf(m.caption)) if (tagShare.get(h) <= posts.length * 0.3) found.add(`tag:${h}`);
    for (const k of found) (keys.get(k) || keys.set(k, []).get(k)).push(m);
  }
  const hiddenSet = new Set(hidden);
  const out = [];
  for (const [key, list] of keys) {
    if (list.length < 3 || hiddenSet.has(key)) continue;
    const sorted = [...list].sort((a, b) => a.posted_at.localeCompare(b.posted_at));
    const spanDays = (Date.parse(sorted[sorted.length - 1].posted_at) - Date.parse(sorted[0].posted_at)) / 86400000;
    if (spanDays < 21) continue;
    const rels = sorted.map((m) => rel(m, media));
    const early = median(rels.slice(0, Math.min(3, Math.floor(rels.length / 2))));
    const late = median(rels.slice(-3));
    const trend = early && late ? late / early : null;
    out.push({
      key,
      label: key.startsWith("tag:") ? key.slice(4) : `“${key.slice(6)}…”`,
      episodes: sorted,
      rels,
      rel: median(rels),
      trend,
      verdict: trend == null ? "too early to tell" : trend >= 1.25 ? "growing" : trend <= 0.8 ? "fading" : "steady",
      last: sorted[sorted.length - 1].posted_at,
    });
  }
  // The same posts found by two keys is one series; keep the one found by more.
  out.sort((a, b) => b.episodes.length - a.episodes.length);
  const seen = [];
  return out.filter((s) => {
    const ids = new Set(s.episodes.map((m) => m.id));
    const dup = seen.some((t) => t.episodes.filter((m) => ids.has(m.id)).length >= Math.min(ids.size, t.episodes.length) * 0.8);
    if (!dup) seen.push(s);
    return !dup;
  }).sort((a, b) => b.last.localeCompare(a.last)).slice(0, 12);
}

/* ---------------------------------- hooks ---------------------------------- */
// The first line of the caption, plus what's said first in the video when
// its upload was transcribed. Patterns only count with five posts a side.
export function hookStats(media, content = []) {
  const spoken = new Map(content.filter((c) => c.igMediaId && c.videoCheck?.speech?.opening).map((c) => [c.igMediaId, c.videoCheck.speech.opening]));
  const rows = usable(media).map((m) => {
    const first = (m.caption || "").split("\n")[0].trim().slice(0, 140);
    return {
      post: m,
      hook: first,
      spoken: spoken.get(m.id) || null,
      rel: rel(m, media),
      watch: m.avg_watch_time_ms ? m.avg_watch_time_ms / 1000 : null,
      question: /\?/.test(first),
      number: /\d/.test(first),
      emojiStart: /^\p{Extended_Pictographic}/u.test(first),
      short: first.length > 0 && first.length <= 40,
      empty: first.length === 0,
    };
  }).filter((r) => r.rel != null);
  const ranked = [...rows].sort((a, b) => b.rel - a.rel);
  const compare = (label, test) => {
    const yes = rows.filter(test);
    const no = rows.filter((r) => !test(r));
    if (yes.length < 5 || no.length < 5) return null;
    const a = median(yes.map((r) => r.rel));
    const b = median(no.map((r) => r.rel));
    return { label, yes: yes.length, no: no.length, ratio: a && b ? a / b : null };
  };
  const patterns = [
    compare("Opens with a question", (r) => r.question),
    compare("Has a number in the first line", (r) => r.number),
    compare("Starts with an emoji", (r) => r.emojiStart),
    compare("First line of 40 characters or fewer", (r) => r.short),
    compare("No caption at all", (r) => r.empty),
  ].filter((p) => p && p.ratio != null && Math.abs(p.ratio - 1) >= 0.1).sort((a, b) => Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1));
  return { best: ranked.slice(0, 8), worst: ranked.slice(-6).reverse(), patterns, total: rows.length };
}

/* ----------------------------- follower conversion ------------------------- */
// Feed posts report follows directly. Reels don't, so theirs are estimated:
// the new follows of the posting day and the next, shared among the posts
// out at that time in proportion to their reach. Shown as an estimate.
export function conversion(media, accountDays = []) {
  const newByDay = new Map(accountDays.filter((d) => d.new_followers != null).map((d) => [d.day, d.new_followers]));
  const posts = usable(media);
  const dayOf = (m) => m.posted_at.slice(0, 10);
  const nextDay = (d) => new Date(Date.parse(d) + 86400000).toISOString().slice(0, 10);
  const rows = posts.map((m) => {
    if (kindOf(m) === "FEED" && m.follows != null) return { post: m, follows: m.follows, estimated: false };
    const d = dayOf(m);
    if (!newByDay.has(d)) return null;
    const window = [d, nextDay(d)];
    const pool = window.reduce((acc, x) => acc + (newByDay.get(x) || 0), 0);
    const sharing = posts.filter((p) => window.includes(dayOf(p)) || window.includes(nextDay(dayOf(p))));
    const reachSum = sharing.reduce((acc, p) => acc + (p.reach || 0), 0) || 1;
    return { post: m, follows: (pool * (m.reach || 0)) / reachSum, estimated: true };
  }).filter(Boolean).map((r) => ({ ...r, per1000: per(r.follows, r.post.reach, 1000) })).filter((r) => r.per1000 != null);
  return {
    rows: [...rows].sort((a, b) => b.per1000 - a.per1000),
    byFormat: Object.entries(rows.reduce((acc, r) => { (acc[formatOf(r.post)] = acc[formatOf(r.post)] || []).push(r.per1000); return acc; }, {}))
      .map(([fmt, list]) => ({ format: fmt, label: FORMAT_LABEL[fmt] || fmt, n: list.length, per1000: list.reduce((a, v) => a + v, 0) / list.length }))
      .filter((g) => g.n >= MIN_GROUP).sort((a, b) => b.per1000 - a.per1000),
  };
}

/* --------------------------------- experiments ----------------------------- */
// board.igExperiments: [{ id, mediaId, change, by, at }]. A test is read
// against the same baseline as everything else: 1.0 is "as usual".
export const EXPERIMENT_PRESETS = [
  "A question in the first line", "Face in the first second", "Text on screen in the first second",
  "Posted at a new time", "Shorter than usual", "Trending audio", "Call to action (save / share)",
  "Carousel instead of a reel", "Subtitles burned in", "Collab post",
];

export function experimentResults(experiments = [], media) {
  const byId = new Map(media.map((m) => [m.id, m]));
  const tests = experiments.map((e) => {
    const post = byId.get(e.mediaId);
    if (!post) return { ...e, post: null, status: "missing" };
    if (!settled(post)) return { ...e, post, status: "waiting" };
    const r = rel(post, media);
    return { ...e, post, status: "done", rel: r, verdict: r == null ? "unclear" : r >= 1.2 ? "better" : r <= 0.8 ? "worse" : "no clear difference" };
  });
  const grouped = {};
  for (const t of tests.filter((x) => x.status === "done" && x.rel != null)) (grouped[t.change] = grouped[t.change] || []).push(t);
  const learned = Object.entries(grouped).map(([change, list]) => {
    const r = median(list.map((t) => t.rel));
    const n = list.length;
    const word = n < 2 ? "one test so far" : r >= 1.2 ? "works for you" : r <= 0.8 ? "doesn't work for you" : "no clear effect";
    return { change, n, rel: r, word };
  }).sort((a, b) => b.n - a.n || (b.rel || 0) - (a.rel || 0));
  return { tests: tests.sort((a, b) => (b.at || "").localeCompare(a.at || "")), learned };
}

/* ------------------------------ retention patterns ------------------------- */
// Uploads that were checked and later linked to their reel: what the checked
// videos that held people had in common. Needs a handful before it says much.
export const RETENTION_MIN = 6;
export function retentionPatterns(content = [], media) {
  const byId = new Map(media.map((m) => [m.id, m]));
  const rows = content.map((c) => {
    const post = c.igMediaId && byId.get(c.igMediaId);
    const vc = c.videoCheck;
    if (!post || !vc?.duration || !post.avg_watch_time_ms) return null;
    return {
      item: c, post,
      completion: post.avg_watch_time_ms / 1000 / vc.duration,
      rel: rel(post, media),
      features: {
        "Length (s)": vc.duration,
        "First cut (s)": vc.firstCut ?? null,
        "Longest shot (s)": vc.longestShot ?? null,
        "Seconds with nothing moving": vc.stillSeconds ?? null,
        "Cuts per 10 s": vc.cutsPer10s ?? null,
        "First spoken word (s)": vc.speech?.status === "ok" ? vc.speech.firstWordAt : null,
        "Loudness (dB)": vc.loudness ?? null,
      },
    };
  }).filter(Boolean);
  if (rows.length < RETENTION_MIN) return { rows, patterns: [] };
  const patterns = [];
  for (const name of Object.keys(rows[0].features)) {
    const have = rows.filter((r) => r.features[name] != null);
    if (have.length < RETENTION_MIN) continue;
    const mid = median(have.map((r) => r.features[name]));
    const low = have.filter((r) => r.features[name] <= mid);
    const high = have.filter((r) => r.features[name] > mid);
    if (low.length < 3 || high.length < 3) continue;
    const a = median(low.map((r) => r.completion));
    const b = median(high.map((r) => r.completion));
    if (!a || !b) continue;
    patterns.push({ name, split: mid, low: a, high: b, gap: Math.abs(a - b) / Math.max(a, b) });
  }
  return { rows, patterns: patterns.filter((p) => p.gap >= 0.12).sort((x, y) => y.gap - x.gap) };
}

/* ----------------------------------- people -------------------------------- */
export function peopleStats(content = [], media, tasks = []) {
  const byId = new Map(media.map((m) => [m.id, m]));
  const people = {};
  for (const c of content) {
    if (!c.uploadedBy) continue;
    const p = (people[c.uploadedBy] = people[c.uploadedBy] || { name: c.uploadedBy, uploads: 0, posts: [] });
    p.uploads++;
    const post = c.igMediaId && byId.get(c.igMediaId);
    if (post && settled(post)) p.posts.push({ post, item: c, rel: rel(post, media), completion: c.videoCheck?.duration && post.avg_watch_time_ms ? post.avg_watch_time_ms / 1000 / c.videoCheck.duration : null });
  }
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  for (const t of tasks) {
    if (!t.assignee || t.status !== "done" || !t.completedAt || t.completedAt < monthAgo) continue;
    (people[t.assignee] = people[t.assignee] || { name: t.assignee, uploads: 0, posts: [] }).dutiesDone = ((people[t.assignee] || {}).dutiesDone || 0) + 1;
  }
  return Object.values(people).map((p) => {
    const sorted = [...p.posts].sort((a, b) => a.post.posted_at.localeCompare(b.post.posted_at));
    const rels = sorted.map((x) => x.rel);
    return {
      ...p,
      dutiesDone: p.dutiesDone || 0,
      rel: median(rels),
      saves: median(p.posts.map((x) => per(x.post.saved, x.post.reach, 100))),
      completion: median(p.posts.map((x) => x.completion)),
      best: [...p.posts].sort((a, b) => (b.rel || 0) - (a.rel || 0))[0] || null,
      trend: rels.length >= 4 ? median(rels.slice(-2)) / (median(rels.slice(0, -2)) || 1) : null,
    };
  }).sort((a, b) => b.posts.length - a.posts.length || b.uploads - a.uploads);
}

/* ------------------------------------ comments ----------------------------- */
// From raw comments: the questions people ask (each a possible post), what
// they keep mentioning, and which posts got people talking.
export function commentInsights(threads = []) {
  const all = threads.flatMap((t) => (t.comments || []).map((c) => ({ ...c, mediaId: t.mediaId, caption: t.caption })));
  const questions = all.filter((c) => /\?/.test(c.text || "") && (c.text || "").length >= 12)
    .sort((a, b) => (b.likes || 0) - (a.likes || 0)).slice(0, 15)
    .map((c) => ({ text: c.text.slice(0, 200), mediaId: c.mediaId, likes: c.likes || 0 }));
  const counts = new Map();
  for (const c of all) for (const w of new Set(wordsOf(c.text))) counts.set(w, (counts.get(w) || 0) + 1);
  const words = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 20);
  const emojiOnly = all.filter((c) => (c.text || "").trim() && !/[\p{L}\p{N}]/u.test(c.text)).length;
  const posts = threads.map((t) => ({ mediaId: t.mediaId, caption: (t.caption || "").slice(0, 80), count: (t.comments || []).length }))
    .filter((p) => p.count).sort((a, b) => b.count - a.count).slice(0, 6);
  return { at: new Date().toISOString().slice(0, 10), total: all.length, questions, words, emojiShare: all.length ? emojiOnly / all.length : 0, posts };
}

/* ----------------------------------- the brief ----------------------------- */
// The month in one page, from all of the above: what to keep doing, what to
// change, one thing to test, when to post, and post ideas built from the
// strongest theme and format. Rules, not a writer — every line says why.
export function buildBrief({ media, themes, content, experiments, comments, accountDays }) {
  const keep = [];
  const change = [];
  const ideas = [];
  const fmtStats = Object.entries(usable(media).filter((m) => Date.now() - Date.parse(m.posted_at) < 365 * 86400000)
    .reduce((acc, m) => { (acc[formatOf(m)] = acc[formatOf(m)] || []).push(m); return acc; }, {}))
    .map(([fmt, list]) => ({ fmt, label: FORMAT_LABEL[fmt], ...groupStats(list, media) })).filter((g) => g.n >= MIN_GROUP);
  const bestFmt = [...fmtStats].sort((a, b) => (b.rel || 0) - (a.rel || 0))[0];
  const worstFmt = [...fmtStats].sort((a, b) => (a.rel || 0) - (b.rel || 0))[0];
  if (bestFmt && bestFmt.rel >= 1.1) keep.push({ text: `Make more ${bestFmt.label.toLowerCase()}`, why: `${bestFmt.rel.toFixed(2)}× your usual reach over the last year (${bestFmt.n} posts).` });
  if (worstFmt && worstFmt !== bestFmt && worstFmt.rel <= 0.85) change.push({ text: `Fewer ${worstFmt.label.toLowerCase()}, or rethink them`, why: `${worstFmt.rel.toFixed(2)}× your usual reach (${worstFmt.n} posts).` });

  const ts = themeStats(media, themes).filter((t) => t.n >= MIN_GROUP && t.rel != null);
  const bestThemes = ts.filter((t) => t.rel >= 1.15).slice(0, 2);
  for (const t of bestThemes) keep.push({ text: `Keep posting about “${t.name}”`, why: `${t.rel.toFixed(2)}× usual reach across ${t.n} posts${t.saves != null ? `, ${t.saves.toFixed(2)} saves per 100 reached` : ""}.` });
  const weakTheme = [...ts].sort((a, b) => a.rel - b.rel)[0];
  if (weakTheme && weakTheme.rel <= 0.8) change.push({ text: `“${weakTheme.name}” posts underperform`, why: `${weakTheme.rel.toFixed(2)}× usual reach (${weakTheme.n} posts). Try a different format or angle for it.` });

  const hooks = hookStats(media, content);
  const topHook = hooks.patterns[0];
  if (topHook) (topHook.ratio > 1 ? keep : change).push({ text: topHook.ratio > 1 ? `${topHook.label} — keep doing it` : `${topHook.label} — it costs you reach`, why: `${topHook.ratio.toFixed(2)}× the reach of posts without it (${topHook.yes} vs ${topHook.no} posts).` });

  const series = detectSeries(media).filter((s) => s.verdict === "fading");
  if (series[0]) change.push({ text: `Refresh the ${series[0].label} series`, why: `Its last episodes reach ${series[0].trend.toFixed(2)}× what the first ones did.` });

  const times = postingTimes(media);
  const when = times.best.slice(0, 2).map((b) => ({ text: `${DAY_NAMES[b.di]} ${TIME_BLOCKS[b.bi].label}`, why: `${b.value.toFixed(2)}× usual reach (${b.n} posts).` }));

  // One thing to test: a preset nobody has tried yet, or the best slot not used lately.
  const tried = new Set((experiments || []).map((e) => e.change));
  const untested = EXPERIMENT_PRESETS.find((p) => !tried.has(p));
  const test = untested ? { text: untested, why: "Not tested yet. Mark the post as a test when it goes out, and the Tests tab reports how it did." } : null;

  // Posting rhythm: the last four weeks against the four before.
  const posted = usable(media).concat(media.filter((m) => kindOf(m) !== "STORY" && !settled(m)));
  const inWeeks = (from, to) => posted.filter((m) => { const d = (Date.now() - Date.parse(m.posted_at)) / 86400000; return d >= from && d < to; }).length;
  const now4 = inWeeks(0, 28);
  const before4 = inWeeks(28, 56);
  if (before4 && now4 < before4 * 0.7) change.push({ text: "Post more often again", why: `${now4} posts in the last four weeks, against ${before4} in the four before.` });
  else if (now4 >= 4) keep.push({ text: "Keep the rhythm", why: `${now4} posts in the last four weeks (${(now4 / 4).toFixed(1)} a week).` });

  const strongTheme = bestThemes[0] || ts[0];
  const fmtName = bestFmt ? bestFmt.label.replace(/s$/, "").toLowerCase() : "post";
  const slot = when[0]?.text;
  if (strongTheme) ideas.push({ title: `${bestFmt ? bestFmt.label.replace(/s$/, "") : "Post"} about ${strongTheme.name}`, detail: `Your strongest theme in your strongest format${slot ? `, out on ${slot}` : ""}.${topHook && topHook.ratio > 1 ? ` ${topHook.label}.` : ""}` });
  for (const q of (comments?.questions || []).slice(0, 2)) ideas.push({ title: `Answer: “${q.text.slice(0, 70)}”`, detail: `Someone asked this in the comments. A ${fmtName} that answers it gives everyone who wondered a reason to watch.` });
  const bestOld = usable(media).filter((m) => Date.now() - Date.parse(m.posted_at) > 180 * 86400000).sort((a, b) => (rel(b, media) || 0) - (rel(a, media) || 0))[0];
  if (bestOld) ideas.push({ title: `Remake a past hit: “${(bestOld.caption || "untitled").split("\n")[0].slice(0, 60)}”`, detail: `It reached ${rel(bestOld, media).toFixed(1)}× your usual back in ${new Date(bestOld.posted_at).getFullYear()}; most of today's followers haven't seen it.`, permalink: bestOld.permalink });

  const days = (accountDays || []).filter((d) => d.reach != null);
  const reachNow = days.slice(-28).reduce((a, d) => a + d.reach, 0);
  return { at: new Date().toISOString().slice(0, 10), keep: keep.slice(0, 4), change: change.slice(0, 3), test, when, ideas: ideas.slice(0, 4), context: { posts4w: now4, reach4w: reachNow } };
}

/* ------------------------------ calendar predictions ----------------------- */
// For a planned post: how many it's likely to reach, from the typical post of
// that kind lately and how its weekday and time usually do.
export function predictReach(media, times, { kind, when }) {
  const pool = usable(media).filter((m) => (kind === "REELS" ? kindOf(m) === "REELS" : kindOf(m) === "FEED"))
    .sort((a, b) => b.posted_at.localeCompare(a.posted_at)).slice(0, 30);
  if (pool.length < 5) return null;
  const typical = median(pool.map((m) => m.reach));
  const d = new Date(when);
  const bi = TIME_BLOCKS.findIndex((b) => d.getHours() >= b.from && d.getHours() < b.to);
  const cell = bi >= 0 ? times.grid[(d.getDay() + 6) % 7][bi] : null;
  const factor = cell && cell.n >= 3 && cell.value ? cell.value : 1;
  return { typical, factor, expected: typical * factor, slotKnown: !!(cell && cell.n >= 3), slot: bi >= 0 ? `${DAY_NAMES[(d.getDay() + 6) % 7]} ${TIME_BLOCKS[bi].label}` : null };
}

// How a quiet spell has gone for this account before: daily reach 4-10 days
// after the last post, against days right after posting. Longer gaps are left
// out — a month off is a different thing from a slow week.
export function quietEffect(media, accountDays = []) {
  const postDays = [...new Set(media.filter((m) => kindOf(m) !== "STORY").map((m) => m.posted_at.slice(0, 10)))].sort();
  const sinceLast = (day) => {
    let last = null;
    for (const p of postDays) { if (p <= day) last = p; else break; }
    return last ? (Date.parse(day) - Date.parse(last)) / 86400000 : null;
  };
  const quiet = [];
  const active = [];
  for (const d of accountDays) {
    if (d.reach == null) continue;
    const gap = sinceLast(d.day);
    if (gap == null) continue;
    if (gap >= 4 && gap <= 10) quiet.push(d.reach);
    else if (gap <= 1) active.push(d.reach);
  }
  if (quiet.length < 5 || active.length < 5) return null;
  return { quiet: median(quiet), active: median(active), ratio: median(quiet) / median(active) };
}
