// Instagram analytics. Reads the rows that api/instagram-sync.js collects and
// draws them.
//
// This lives outside App.jsx on purpose: App.jsx is one 6,900-line file and
// another session is editing it, so a separate module keeps the shared-file
// footprint down to an import and a route.
//
// Charts are hand-rolled SVG rather than a charting library, matching how the
// rest of this app is built and keeping the bundle free of a ~100KB dependency
// for what amounts to four chart shapes.
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { supabase } from "./supabaseClient";
import {
  Instagram, RefreshCw, ArrowUpRight, ArrowDownRight, ExternalLink,
  AlertTriangle, Check, Eye, Users, Play, Table2, BarChart3, X,
  ChevronLeft, ChevronRight, Sparkles, Clock, LayoutGrid, Film,
} from "lucide-react";
import {
  SETTLE_DAYS, MIN_PEERS, kindOf, KIND_NOUN, formatOf, FORMAT_LABEL, ageDays, per, median, percentile,
  engagementRate, peersFor, relativeReach, captionStats, postingTimes, slotFor, formatComparison, DAY_NAMES, TIME_BLOCKS,
} from "./igInsights";
import VideoCheck, { AiFeedback } from "./VideoCheck";
import "./analytics.css";

/* --------------------------------- palette --------------------------------
   The app's own brand tokens, stepped into the dark-mode lightness band and
   validated as a categorical set against the panel surface (#191C25): worst
   adjacent CVD ΔE 9.5, worst normal-vision ΔE 15.8, all five slots >= 3:1
   contrast. Assign these in fixed order and never cycle them -- a sixth series
   folds into "Other" instead. Green is deliberately absent: this app already
   uses green for status (--good), and status hues stay reserved.            */
const SERIES = ["#B08B33", "#2E9C88", "#D9564B", "#8E86E5", "#D2668F"];
const SURFACE = "#191C25";   // --panel, the surface charts sit on
const GRID = "rgba(237,235,227,0.09)";
const INK = "#EDEBE3";
const MUTED = "#8B8E9C";

/* -------------------------------- formatting ------------------------------ */
const compact = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(0)}K`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
};
const full = (n) => (n == null ? "—" : Math.round(n).toLocaleString());
const pct = (n) => (n == null ? "—" : `${n.toFixed(1)}%`);
const shortDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const watchTime = (ms) => {
  if (!ms) return "—";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
};

/* ------------------------------ chart plumbing ---------------------------- */

// Charts need pixel width for hit-testing, so measure rather than guess.
function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(720);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.width;
      if (next > 0) setW(next);
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// Axis ticks on clean round numbers, so the reader gets 0 / 1,000 / 2,000
// rather than 0 / 1,137 / 2,274.
function niceTicks(max, count = 4) {
  if (!max || max <= 0) return [0, 1];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) * mag;
  const out = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  return out;
}

// A bar with its data-end rounded and its baseline end square, per the mark
// spec. Horizontal bars only, growing left-to-right from x0.
function barPath(x0, y, w, h, r = 4) {
  const radius = Math.min(r, w, h / 2);
  if (w <= 0) return "";
  return `M${x0},${y} H${x0 + w - radius} A${radius},${radius} 0 0 1 ${x0 + w},${y + radius}` +
    ` V${y + h - radius} A${radius},${radius} 0 0 1 ${x0 + w - radius},${y + h} H${x0} Z`;
}

/* --------------------------------- Sparkline ------------------------------ */
function Sparkline({ values, color = SERIES[0], width = 96, height = 26 }) {
  const clean = (values || []).filter((v) => typeof v === "number");
  if (clean.length < 2) return <div style={{ width, height }} />;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min || 1;
  const step = width / (clean.length - 1);
  const pts = clean.map((v, i) => [i * step, height - 2 - ((v - min) / span) * (height - 4)]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} aria-hidden="true" style={{ display: "block" }}>
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.55" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="3" fill={color} />
    </svg>
  );
}

/* -------------------------------- Stat tile ------------------------------- */
function StatTile({ label, value, delta, deltaLabel, spark, icon: Icon, upIsGood = true }) {
  const dir = delta == null ? 0 : Math.sign(delta);
  // Color says direction-and-whether-that-is-good; the arrow and the sign say
  // it again, so the meaning never rests on color alone.
  const good = upIsGood ? dir > 0 : dir < 0;
  const deltaColor = dir === 0 ? MUTED : good ? "var(--good)" : "var(--alert)";
  const Arrow = dir >= 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <div className="ig-tile">
      <div className="ig-tile-head">
        {Icon ? <Icon size={14} strokeWidth={1.75} /> : null}
        <span>{label}</span>
      </div>
      <div className="ig-tile-value">{value}</div>
      <div className="ig-tile-foot">
        {delta != null ? (
          <span className="ig-delta" style={{ color: deltaColor }}>
            <Arrow size={13} strokeWidth={2} />
            {Math.abs(delta).toFixed(1)}%
            <span className="ig-delta-label">{deltaLabel}</span>
          </span>
        ) : <span className="ig-delta-label">{deltaLabel || "no comparison yet"}</span>}
        {spark?.length ? <Sparkline values={spark} /> : null}
      </div>
    </div>
  );
}

/* -------------------------------- Line chart ------------------------------
   Crosshair + tooltip by default: this is an HTML chart, so it should be
   readable by pointing at it, not only by squinting at the axis.            */
function LineChart({ series, height = 240, valueFormat = compact }) {
  const [wrapRef, width] = useWidth();
  const [hover, setHover] = useState(null);
  const live = series.filter((s) => s.points.some((p) => p.value != null));

  const pad = { top: 16, right: 56, bottom: 26, left: 46 };
  const plotW = Math.max(40, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;

  const days = useMemo(() => {
    const set = new Set();
    for (const s of live) for (const p of s.points) set.add(p.day);
    return [...set].sort();
  }, [live]);

  const max = useMemo(() => {
    let m = 0;
    for (const s of live) for (const p of s.points) if (p.value > m) m = p.value;
    return m;
  }, [live]);

  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const x = useCallback((day) => {
    const i = days.indexOf(day);
    return days.length < 2 ? plotW / 2 : (i / (days.length - 1)) * plotW;
  }, [days, plotW]);
  const y = useCallback((v) => plotH - (v / top) * plotH, [plotH, top]);

  const onMove = (e) => {
    if (days.length < 2) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left - pad.left;
    const i = Math.max(0, Math.min(days.length - 1, Math.round((px / plotW) * (days.length - 1))));
    setHover(days[i]);
  };

  if (!live.length || !days.length) {
    return <div className="ig-empty-chart">Nothing collected for this range yet.</div>;
  }

  return (
    <div ref={wrapRef} className="ig-chart-wrap">
      <svg
        width="100%" height={height} role="img"
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        style={{ display: "block", overflow: "visible" }}
      >
        <g transform={`translate(${pad.left},${pad.top})`}>
          {/* Recessive hairline grid, solid never dashed */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1="0" x2={plotW} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth="1" />
              <text x="-10" y={y(t)} textAnchor="end" dominantBaseline="middle"
                fill={MUTED} fontSize="11" style={{ fontVariantNumeric: "tabular-nums" }}>
                {compact(t)}
              </text>
            </g>
          ))}

          {hover ? <line x1={x(hover)} x2={x(hover)} y1="0" y2={plotH} stroke={GRID} strokeWidth="1" /> : null}

          {live.map((s, si) => {
            const color = s.color || SERIES[si % SERIES.length];
            const pts = s.points.filter((p) => p.value != null);
            if (!pts.length) return null;
            const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.day).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
            const area = `${d} L${x(pts[pts.length - 1].day).toFixed(1)},${plotH} L${x(pts[0].day).toFixed(1)},${plotH} Z`;
            const last = pts[pts.length - 1];
            return (
              <g key={s.label}>
                {live.length === 1 ? <path d={area} fill={color} opacity="0.1" /> : null}
                <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                {/* End marker: >=8px with a 2px surface ring so it stays legible
                    where series cross each other. */}
                <circle cx={x(last.day)} cy={y(last.value)} r="4.5" fill={color} stroke={SURFACE} strokeWidth="2" />
                {/* Direct label rides the line end -- the endpoint only, never
                    a number on every point. */}
                <text x={x(last.day) + 10} y={y(last.value)} dominantBaseline="middle"
                  fill={INK} fontSize="11" fontWeight="600" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {valueFormat(last.value)}
                </text>
              </g>
            );
          })}

          {hover ? live.map((s, si) => {
            const p = s.points.find((q) => q.day === hover);
            if (!p || p.value == null) return null;
            return (
              <circle key={s.label} cx={x(hover)} cy={y(p.value)} r="4.5"
                fill={s.color || SERIES[si % SERIES.length]} stroke={SURFACE} strokeWidth="2" />
            );
          }) : null}

          {/* Endpoints only on the x-axis; a tick per day turns to mush. */}
          <text x="0" y={plotH + 18} fill={MUTED} fontSize="11">{shortDate(days[0])}</text>
          <text x={plotW} y={plotH + 18} textAnchor="end" fill={MUTED} fontSize="11">
            {shortDate(days[days.length - 1])}
          </text>
        </g>
      </svg>

      {hover ? (
        <div className="ig-tooltip" style={{
          left: Math.min(Math.max(x(hover) + pad.left, 70), width - 70),
        }}>
          <div className="ig-tooltip-day">{shortDate(hover)}</div>
          {live.map((s, si) => {
            const p = s.points.find((q) => q.day === hover);
            return (
              <div key={s.label} className="ig-tooltip-row">
                <span className="ig-swatch" style={{ background: s.color || SERIES[si % SERIES.length] }} />
                <span className="ig-tooltip-label">{s.label}</span>
                <span className="ig-tooltip-value">{p?.value == null ? "—" : full(p.value)}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// Identity never rests on color alone: two or more series always get a legend.
function Legend({ series }) {
  if (series.length < 2) return null;
  return (
    <div className="ig-legend">
      {series.map((s, i) => (
        <span key={s.label} className="ig-legend-item">
          <span className="ig-swatch" style={{ background: s.color || SERIES[i % SERIES.length] }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

/* --------------------------------- Bar chart ------------------------------ */
function BarChart({ rows, valueFormat = full, color = SERIES[0], onRowClick }) {
  const [wrapRef, width] = useWidth();
  const [hover, setHover] = useState(null);
  if (!rows.length) return <div className="ig-empty-chart">Nothing to rank yet.</div>;

  const labelW = Math.min(180, Math.max(90, width * 0.28));
  const valueW = 62;
  const plotW = Math.max(40, width - labelW - valueW);
  const max = Math.max(...rows.map((r) => r.value || 0)) || 1;
  const slot = 30;
  const barH = Math.min(24, slot - 8); // capped; the leftover is air, not fill

  return (
    <div ref={wrapRef} className="ig-chart-wrap">
      <svg width="100%" height={rows.length * slot + 8} style={{ display: "block" }} role="img">
        {rows.map((r, i) => {
          const w = ((r.value || 0) / max) * plotW;
          const yTop = i * slot + 4;
          return (
            <g key={r.id || r.label}
              onMouseEnter={() => setHover(r)} onMouseLeave={() => setHover(null)}
              onClick={() => onRowClick?.(r)}
              style={{ cursor: onRowClick ? "pointer" : "default" }}>
              {/* Hit target spans the whole row, not just the bar. */}
              <rect x="0" y={yTop - 4} width={Math.max(width, 1)} height={slot} fill="transparent" />
              <text x="0" y={yTop + barH / 2} dominantBaseline="middle" fill={MUTED} fontSize="12">
                {r.label.length > 26 ? `${r.label.slice(0, 25)}…` : r.label}
              </text>
              <path d={barPath(labelW, yTop, Math.max(w, 2), barH)} fill={color}
                opacity={hover && hover !== r ? 0.5 : 1} />
              <text x={labelW + Math.max(w, 2) + 8} y={yTop + barH / 2} dominantBaseline="middle"
                fill={INK} fontSize="11" fontWeight="600" style={{ fontVariantNumeric: "tabular-nums" }}>
                {valueFormat(r.value)}
              </text>
            </g>
          );
        })}
      </svg>
      {hover?.sub ? <div className="ig-bar-hint">{hover.sub}</div> : null}
    </div>
  );
}

/* ------------------------------- post review ------------------------------
   One post, opened: every number it has, each set against the account's own
   typical post of the same kind, and what that comparison says went well and
   what could go better.

   "Typical" is the median of the 30 posts of the same kind posted closest in
   time to this one (see igInsights.js) -- reels against reels, and against
   the ones from around the same time, because a 2019 post was seen by a much
   smaller account. Posts under three days old are left out of the baseline
   (their numbers are still climbing), and a comparison needs five peers.

   The verdicts compare rates (saves per account reached, and so on) rather
   than raw counts, so a post that reached fewer people isn't also marked down
   for every other number. They say what happened next to the norm; the
   suggestions are the usual levers for that number, not a diagnosis. */
const MIN_COUNT = 3;
const fixed = (digits, suffix = "") => (v) => (v == null ? "—" : `${v.toFixed(digits)}${suffix}`);

// Each measure: how to read it off a post, and what to say when it is well
// above or below the norm. good/weak get the ratio (2.1 = 2.1x typical).
// count is the raw number behind a rate: "2.4x the comments" is noise when it
// means two comments instead of one, so a verdict needs MIN_COUNT behind it.
// Instagram reports follows and profile visits for feed posts only.
const MEASURES = [
  {
    key: "reach", label: "Accounts reached", get: (m) => m.reach, format: full,
    good: (r, n) => `Reached ${r.toFixed(1)}× more accounts than your typical ${n} — Instagram pushed this one out well beyond the usual audience.`,
    weak: (r, n) => `Reached ${Math.round((1 - r) * 100)}% fewer accounts than your typical ${n}. Reach is mostly decided in the first hour: the opening frame or cover, and posting when your audience is online, matter most.`,
  },
  {
    key: "views", label: "Views per account reached", get: (m) => per(m.views, m.reach, 1), format: fixed(2),
    good: (r) => `Each person who saw it watched or opened it ${r.toFixed(1)}× as often as usual — people came back to it, or let it loop.`,
    weak: null,
  },
  {
    key: "saves", label: "Saves per 100 reached", get: (m) => per(m.saved, m.reach, 100), count: (m) => m.saved, format: fixed(2),
    good: (r) => `Saved ${r.toFixed(1)}× as often as usual — people found it worth coming back to. Saves are one of the strongest signals Instagram uses.`,
    weak: () => "Saved less often than usual. Saves come from practical value: tips, steps, lists or anything people want to find again.",
  },
  {
    key: "shares", label: "Shares per 100 reached", get: (m) => per(m.shares, m.reach, 100), count: (m) => m.shares, format: fixed(2),
    good: (r) => `Shared ${r.toFixed(1)}× as often as usual — shares carry a post to people who don't follow you yet.`,
    weak: () => "Shared less often than usual. People share what they recognise themselves in, or want to show a particular friend.",
  },
  {
    key: "comments", label: "Comments per 100 reached", get: (m) => per(m.comments, m.reach, 100), count: (m) => m.comments, format: fixed(2),
    good: (r) => `Drew ${r.toFixed(1)}× the usual rate of comments — it got people talking.`,
    weak: () => "Fewer comments than usual. A direct question or an opinion to react to in the caption gives people a reason to reply.",
  },
  {
    key: "likes", label: "Likes per 100 reached", get: (m) => per(m.likes, m.reach, 100), count: (m) => m.likes, format: fixed(1),
    good: (r) => `Liked by ${r.toFixed(1)}× the usual share of people who saw it.`,
    weak: () => "A smaller share of viewers liked it than usual — it reached people, but fewer of them were moved to react.",
  },
  {
    key: "engagement", label: "Engagement rate", get: engagementRate, format: fixed(1, "%"),
    good: null, weak: null,
  },
  {
    key: "follows", label: "Follows per 1,000 reached", get: (m) => per(m.follows, m.reach, 1000), count: (m) => m.follows, format: fixed(1), feedOnly: true,
    good: (r) => `Turned viewers into followers at ${r.toFixed(1)}× the usual rate — this is the kind of post that grows the account.`,
    weak: null, // most posts gain almost no follows, so "below typical" here is noise
  },
  {
    key: "visits", label: "Profile visits per 1,000 reached", get: (m) => per(m.profile_visits, m.reach, 1000), count: (m) => m.profile_visits, format: fixed(1), feedOnly: true,
    good: (r) => `Sent people to your profile ${r.toFixed(1)}× as often as usual — it made them curious about the account.`,
    weak: null,
  },
  {
    key: "watch", label: "Average watch time", get: (m) => (m.avg_watch_time_ms ? m.avg_watch_time_ms / 1000 : null), format: fixed(1, "s"), reelsOnly: true,
    good: (r) => `People watched ${r.toFixed(1)}× longer than on your typical reel — it held attention.`,
    weak: () => "Viewers left earlier than on your typical reel. Get to the point in the first one or two seconds and cut anything slow.",
  },
  {
    key: "watchTotal", label: "Total time watched", get: (m) => (m.total_watch_time_ms ? m.total_watch_time_ms / 60000 : null), format: fixed(0, " min"), reelsOnly: true,
    good: null, weak: null,
  },
];

function reviewPost(post, all) {
  const kind = kindOf(post);
  const peers = peersFor(post, all);
  const rows = [];
  const good = [];
  const weak = [];
  for (const ms of MEASURES) {
    if (ms.reelsOnly && kind !== "REELS") continue;
    if (ms.feedOnly && kind !== "FEED") continue;
    const value = ms.get(post);
    const peerValues = peers.map(ms.get);
    const typical = peers.length >= MIN_PEERS ? median(peerValues) : null;
    const ratio = value != null && typical ? value / typical : null;
    const pct = peers.length >= MIN_PEERS ? percentile(value, peerValues) : null;
    rows.push({ ...ms, value, typical, ratio, pct });
    if (ratio == null) continue;
    // Praise needs this post's own count to be real; criticism needs the
    // typical post to have a real count to fall short of.
    const enoughHere = !ms.count || (ms.count(post) || 0) >= MIN_COUNT;
    const enoughTypical = !ms.count || (median(peers.map(ms.count)) || 0) >= MIN_COUNT;
    if (ratio >= 1.4 && ms.good && enoughHere) good.push({ key: ms.key, score: ratio, text: ms.good(ratio, KIND_NOUN[kind]) });
    if (ratio <= 0.7 && ms.weak && enoughTypical) weak.push({ key: ms.key, score: 1 / Math.max(ratio, 0.01), text: ms.weak(ratio, KIND_NOUN[kind]) });
  }
  good.sort((a, b) => b.score - a.score);
  weak.sort((a, b) => b.score - a.score);

  // A post that travels far past the followers reaches people who care less,
  // so its per-person rates dip. That is the cost of the reach, not a flaw.
  if (good.some((g) => g.key === "reach") && weak.some((w) => w.key !== "reach")) {
    weak.push({ key: "context", score: 0, text: "Some of the dip above is expected: when a post reaches well beyond your followers, a smaller share of those people react to it." });
  }

  const byReach = [...peers, post].filter((m) => m.reach != null).sort((a, b) => b.reach - a.reach);
  const rank = byReach.findIndex((m) => m.id === post.id) + 1;
  const best = [...peers].sort((a, b) => (b.reach || 0) - (a.reach || 0)).slice(0, 3);

  // The caption next to the top quarter of its peers by reach.
  const top = [...peers].sort((a, b) => (b.reach || 0) - (a.reach || 0)).slice(0, Math.max(3, Math.ceil(peers.length / 4)));
  const topCaptions = top.map((m) => captionStats(m.caption));
  const caption = {
    mine: captionStats(post.caption),
    top: {
      length: median(topCaptions.map((c) => c.length)),
      hashtags: median(topCaptions.map((c) => c.hashtags)),
      question: topCaptions.filter((c) => c.question).length / (topCaptions.length || 1),
      cta: topCaptions.filter((c) => c.cta).length / (topCaptions.length || 1),
    },
  };

  const dates = peers.map((m) => m.posted_at).sort();
  const span = dates.length ? [dates[0], dates[dates.length - 1]] : null;
  return { kind, peers: peers.length, span, rows, good, weak, rank, rankOf: byReach.length, best, caption };
}

function captionAdvice(c) {
  const out = [];
  if (c.mine.length === 0) out.push("There's no caption. Even one line gives people something to react to and tells Instagram what the post is about.");
  if (c.mine.firstLineLength > 125) out.push(`The first line is ${c.mine.firstLineLength} characters; Instagram cuts the caption off around 125 in the feed, so the hook may sit behind "more".`);
  if (c.mine.hashtags > 10) out.push(`${c.mine.hashtags} hashtags is a lot — 3 to 5 that really describe the post do as well and read better.`);
  if (!c.mine.question && c.top.question >= 0.5) out.push("Most of your best-reaching posts from this period ask a question in the caption; this one doesn't.");
  if (!c.mine.cta && c.top.cta >= 0.5) out.push("Most of your best-reaching posts ask people to do something (save, share, comment, tag); this one doesn't.");
  if (c.top.length && c.mine.length && c.mine.length < c.top.length * 0.4) out.push(`It's much shorter than your best performers (${c.mine.length} vs about ${Math.round(c.top.length)} characters).`);
  return out;
}

function PercentBar({ pct }) {
  if (pct == null) return <span className="ig-dim">—</span>;
  const color = pct >= 70 ? "var(--good)" : pct <= 30 ? "var(--alert)" : MUTED;
  return (
    <span className="ig-pctbar" title={`Better than ${Math.round(pct)}% of them`}>
      <span className="ig-pctbar-track"><span className="ig-pctbar-dot" style={{ left: `${pct}%`, background: color }} /></span>
      <span style={{ color, minWidth: 30, textAlign: "right" }}>{Math.round(pct)}%</span>
    </span>
  );
}

function PostReview({ post, media, times, list, onSelect, onClose }) {
  const [history, setHistory] = useState(null);
  const [ai, setAi] = useState(null); // null | "loading" | { error } | result
  const index = list.findIndex((m) => m.id === post.id);
  const prev = index > 0 ? list[index - 1] : null;
  const next = index >= 0 && index < list.length - 1 ? list[index + 1] : null;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && prev) onSelect(prev);
      if (e.key === "ArrowRight" && next) onSelect(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onSelect, prev, next]);
  useEffect(() => {
    let live = true;
    setHistory(null);
    setAi(null);
    supabase.from("ig_media_snapshots").select("captured_at,views,reach,likes,saved,shares")
      .eq("media_id", post.id).order("captured_at", { ascending: true })
      .then(({ data }) => { if (live) setHistory(data || []); });
    return () => { live = false; };
  }, [post.id]);

  const review = useMemo(() => reviewPost(post, media), [post, media]);
  const slot = useMemo(() => (times ? slotFor(post, times) : null), [post, times]);
  const noun = KIND_NOUN[review.kind];
  const fetched = post.reach != null || post.views != null;
  const young = ageDays(post) < SETTLE_DAYS;
  const enough = review.peers >= MIN_PEERS;
  const reachRow = review.rows.find((r) => r.key === "reach");
  const advice = captionAdvice(review.caption);

  // One point per day: the latest snapshot of each day, and what each day added.
  const daily = useMemo(() => {
    const byDay = new Map();
    for (const s of history || []) byDay.set(s.captured_at.slice(0, 10), s);
    const entries = [...byDay.entries()];
    return entries.map(([day, s], i) => ({
      day, ...s, gained: i ? (s.views ?? 0) - (entries[i - 1][1].views ?? 0) : null,
    }));
  }, [history]);
  const growth = useMemo(() => ([
    { label: "Views", color: SERIES[0], points: daily.map((d) => ({ day: d.day, value: d.views })) },
    { label: "Reach", color: SERIES[1], points: daily.map((d) => ({ day: d.day, value: d.reach })) },
  ].filter((s) => s.points.some((p) => p.value != null))), [daily]);

  const askAi = async () => {
    setAi("loading");
    try {
      const res = await fetch("/api/video-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "post",
          imageUrl: post.thumbnail_url || post.media_url || null,
          caption: post.caption || "",
          kind: noun,
          format: formatOf(post),
          postedAt: post.posted_at,
          slot: slot ? `${slot.day} ${slot.block}${slot.n >= 3 && slot.value ? `, a slot that usually gets ${slot.value.toFixed(2)}x typical reach` : ""}` : null,
          measures: review.rows.map((r) => ({ label: r.label, value: r.format(r.value), typical: r.format(r.typical), betterThanPct: r.pct == null ? null : Math.round(r.pct) })),
          rank: enough ? `#${review.rank} of ${review.rankOf} by reach` : null,
          bestCaptions: review.best.map((m) => (m.caption || "").slice(0, 300)),
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `The AI read failed (${res.status}).`);
      setAi(out);
    } catch (err) {
      setAi({ error: err.message });
    }
  };

  return (
    <div className="ig-review-backdrop" onClick={onClose}>
      <div className="ig-review" role="dialog" aria-modal="true" aria-label="Post analytics" onClick={(e) => e.stopPropagation()}>
        <button className="ig-review-close" onClick={onClose} aria-label="Close"><X size={20} /></button>

        <div className="ig-review-nav">
          <button className="btn btn-ghost" disabled={!prev} onClick={() => prev && onSelect(prev)}><ChevronLeft size={14} /> Newer</button>
          <span className="ig-dim">{index >= 0 ? `${index + 1} of ${list.length}` : ""}</span>
          <button className="btn btn-ghost" disabled={!next} onClick={() => next && onSelect(next)}>Older <ChevronRight size={14} /></button>
        </div>

        <div className="ig-review-top">
          {post.thumbnail_url || post.media_url ? (
            <img className="ig-review-img" src={post.thumbnail_url || post.media_url} alt="" />
          ) : <div className="ig-review-img" />}
          <div className="ig-review-meta">
            <div className="ig-dim">
              {FORMAT_SINGULAR[formatOf(post)] || noun} · {post.posted_at ? new Date(post.posted_at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
            </div>
            <p className="ig-review-caption">{post.caption || "(no caption)"}</p>
            {post.permalink ? (
              <a className="ig-review-link" href={post.permalink} target="_blank" rel="noreferrer">
                <ExternalLink size={13} /> Open on Instagram
              </a>
            ) : null}
          </div>
        </div>

        {!fetched ? (
          <div className="ig-note">
            This post's numbers haven't been fetched yet. Posts from the last month are fetched every
            night, and older ones are filled in about 40 a night.
          </div>
        ) : (
          <>
            {young ? (
              <div className="ig-note">
                Posted less than {SETTLE_DAYS} days ago — the numbers are still climbing, so compare again in a few days.
              </div>
            ) : null}

            {enough ? (
              <div className="ig-review-badges">
                <span className="ig-badge"><strong>#{review.rank}</strong> of {review.rankOf} by reach</span>
                {reachRow?.ratio != null ? (
                  <span className="ig-badge" style={{ color: reachRow.ratio >= 1.4 ? "var(--good)" : reachRow.ratio <= 0.7 ? "var(--alert)" : undefined }}>
                    <strong>{reachRow.ratio.toFixed(1)}×</strong> typical reach
                  </span>
                ) : null}
                {review.rows.filter((r) => r.pct != null && r.key !== "reach").sort((a, b) => b.pct - a.pct).slice(0, 1).map((r) => (
                  <span key={r.key} className="ig-badge">Strongest: <strong>{r.label.toLowerCase()}</strong> (beats {Math.round(r.pct)}%)</span>
                ))}
              </div>
            ) : null}

            {review.good.length || review.weak.length ? (
              <div className="ig-review-verdicts">
                {review.good.length ? (
                  <section className="ig-verdict ig-verdict-good">
                    <h4><ArrowUpRight size={15} /> What worked</h4>
                    <ul>{review.good.map((g) => <li key={g.text}>{g.text}</li>)}</ul>
                  </section>
                ) : null}
                {review.weak.length ? (
                  <section className="ig-verdict ig-verdict-weak">
                    <h4><ArrowDownRight size={15} /> What could be better</h4>
                    <ul>{review.weak.map((w) => <li key={w.text}>{w.text}</li>)}</ul>
                  </section>
                ) : null}
              </div>
            ) : enough ? (
              <div className="ig-note">Close to your typical {noun} on every measure — nothing stands out either way.</div>
            ) : (
              <div className="ig-note">
                Not enough earlier {noun}s with numbers to compare against yet ({review.peers} of {MIN_PEERS} needed).
                The comparison appears as more posts are fetched.
              </div>
            )}

            <div className="ig-review-stats">
              {[
                ["Views", post.views], ["Reach", post.reach], ["Likes", post.likes],
                ["Comments", post.comments], ["Saves", post.saved], ["Shares", post.shares],
                ...(review.kind === "FEED" ? [["Follows", post.follows], ["Profile visits", post.profile_visits]] : []),
              ].map(([label, v]) => (
                <div key={label} className="ig-review-stat">
                  <div className="ig-dim">{label}</div>
                  <div className="ig-review-stat-value">{full(v)}</div>
                </div>
              ))}
              {review.kind === "REELS" ? (
                <div className="ig-review-stat">
                  <div className="ig-dim">Avg watch</div>
                  <div className="ig-review-stat-value">{watchTime(post.avg_watch_time_ms)}</div>
                </div>
              ) : null}
            </div>

            {enough ? (
              <section className="ig-card ig-review-card">
                <h3>Against your typical {noun}</h3>
                <p className="ig-dim ig-review-sub">
                  Typical = the middle value of the {review.peers} {noun}s posted closest in time to this one
                  {review.span ? ` (${monthYear(review.span[0])} – ${monthYear(review.span[1])})` : ""}.
                  The last column is how many of them this one beats.
                </p>
                <div className="ig-table-scroll">
                  <table className="ig-table ig-review-table">
                    <thead><tr><th>Measure</th><th className="num">This {noun}</th><th className="num">Typical</th><th className="num">Difference</th><th>Beats</th></tr></thead>
                    <tbody>
                      {review.rows.map((r) => (
                        <tr key={r.key}>
                          <td>{r.label}</td>
                          <td className="num">{r.format(r.value)}</td>
                          <td className="num">{r.format(r.typical)}</td>
                          <td className="num" style={{ color: r.ratio == null ? MUTED : r.ratio >= 1.4 ? "var(--good)" : r.ratio <= 0.7 ? "var(--alert)" : MUTED }}>
                            {r.ratio == null ? "—" : `${r.ratio >= 1 ? "+" : "−"}${Math.abs(Math.round((r.ratio - 1) * 100))}%`}
                          </td>
                          <td><PercentBar pct={r.pct} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}

            <div className="ig-review-pair">
              <section className="ig-card ig-review-card">
                <h3>When it went out</h3>
                {slot ? (
                  <>
                    <p style={{ margin: "0 0 8px", fontSize: 13 }}>
                      {slot.day}, {slot.block}.{" "}
                      {slot.n >= 3 && slot.value != null
                        ? <>Posts in this slot usually get <strong style={{ color: slot.value >= 1.15 ? "var(--good)" : slot.value <= 0.85 ? "var(--alert)" : undefined }}>{slot.value.toFixed(2)}×</strong> your typical reach ({slot.n} posts).</>
                        : <>Too few posts in this slot to say how it usually does.</>}
                    </p>
                    {times?.best?.length ? (
                      <p className="ig-dim" style={{ margin: 0 }}>
                        Your strongest slots: {times.best.map((b) => `${DAY_NAMES[b.di]} ${TIME_BLOCKS[b.bi].label} (${b.value.toFixed(2)}×)`).join(" · ")}.
                      </p>
                    ) : null}
                  </>
                ) : <p className="ig-dim">No posting time recorded.</p>}
              </section>

              <section className="ig-card ig-review-card">
                <h3>The caption</h3>
                <div className="ig-caption-facts">
                  <span>{review.caption.mine.length} characters</span>
                  <span>{review.caption.mine.hashtags} hashtags</span>
                  <span>{review.caption.mine.mentions} mentions</span>
                  <span>{review.caption.mine.emoji} emoji</span>
                  <span>{review.caption.mine.question ? "asks a question" : "no question"}</span>
                  <span>{review.caption.mine.cta ? "has a call to action" : "no call to action"}</span>
                </div>
                {enough && review.caption.top.length != null ? (
                  <p className="ig-dim" style={{ margin: "8px 0 0" }}>
                    Your best-reaching {noun}s from this period: about {Math.round(review.caption.top.length)} characters and {Math.round(review.caption.top.hashtags)} hashtags;
                    {" "}{Math.round(review.caption.top.question * 100)}% ask a question, {Math.round(review.caption.top.cta * 100)}% ask people to do something.
                  </p>
                ) : null}
                {advice.length ? <ul className="ig-advice">{advice.map((a) => <li key={a}>{a}</li>)}</ul> : null}
              </section>
            </div>

            <section className="ig-card ig-review-card">
              <h3>Growth since it was first fetched</h3>
              {history == null ? <div className="ig-empty-chart">Loading…</div>
                : daily.length < 2 ? (
                  <div className="ig-empty-chart">
                    One reading so far. The numbers are recorded again each night, so this fills in over the coming days.
                  </div>
                ) : (
                  <>
                    <Legend series={growth} />
                    <LineChart series={growth} height={190} />
                    <div className="ig-gains">
                      {daily.slice(1).map((d) => (
                        <span key={d.day}><span className="ig-dim">{shortDate(d.day)}</span> +{full(d.gained)} views</span>
                      ))}
                    </div>
                  </>
                )}
            </section>

            {review.best.length ? (
              <section className="ig-card ig-review-card">
                <h3>Your best {noun}s from around the same time</h3>
                <div className="ig-best-row">
                  {review.best.map((m) => (
                    <button key={m.id} className="ig-best" onClick={() => onSelect(m)}>
                      {m.thumbnail_url || m.media_url ? <img src={m.thumbnail_url || m.media_url} alt="" loading="lazy" /> : <span className="ig-thumb-blank" />}
                      <span className="ig-best-num">{full(m.reach)} reached</span>
                      <span className="ig-dim">{monthYear(m.posted_at)}</span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="ig-card ig-review-card">
              <div className="ig-card-head">
                <h3>AI read</h3>
                {ai !== "loading" ? (
                  <button className="btn btn-ghost" onClick={askAi}><Sparkles size={14} /> {ai && !ai.error ? "Ask again" : "Get an AI read"}</button>
                ) : null}
              </div>
              {!ai ? <p className="ig-dim" style={{ margin: 0 }}>Looks at the cover image, the caption and every number above, and says in plain words why it did how it did and what to try next time.</p> : null}
              {ai === "loading" ? <div className="ig-empty-chart">Reading the post…</div> : null}
              {ai?.error ? <div className="ig-note ig-note-bad"><AlertTriangle size={14} /> {ai.error}</div> : null}
              {ai && ai !== "loading" && !ai.error ? <AiFeedback result={ai} /> : null}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

const FORMAT_SINGULAR = { reel: "Reel", carousel: "Carousel", photo: "Photo", video: "Feed video", story: "Story" };
const monthYear = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" });

/* ------------------------------- data loading ----------------------------- */
function useInstagramData(days) {
  const [state, setState] = useState({ loading: true, media: [], account: [], demo: [], error: null });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    // Twice the range, so the period before it is there to compare against.
    const since = new Date(Date.now() - (2 * days + 1) * 86400000).toISOString().slice(0, 10);
    try {
      const [mediaRes, acctRes, demoRes] = await Promise.all([
        supabase.from("ig_media_latest").select("*").order("posted_at", { ascending: false }).range(0, 1999),
        supabase.from("ig_account_snapshots").select("*").gte("day", since).order("day", { ascending: true }),
        supabase.from("ig_demographics").select("*"),
      ]);
      const error = mediaRes.error || acctRes.error || demoRes.error;
      setState({
        loading: false,
        media: mediaRes.data || [],
        account: acctRes.data || [],
        demo: demoRes.data || [],
        // A missing table is the single most likely first-run failure, so name
        // the fix rather than echoing Postgres at the reader.
        error: error
          ? (/relation .* does not exist|schema cache/i.test(error.message)
            ? "The Instagram tables aren't in Supabase yet — run supabase-instagram-schema.sql."
            : error.message)
          : null,
      });
    } catch (err) {
      setState({ loading: false, media: [], account: [], demo: [], error: err.message });
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

/* ------------------------------ posts & timing ---------------------------- */

function useNarrow(query = "(max-width: 820px)") {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e) => setNarrow(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return narrow;
}

// Stories vanish from Instagram's API a day after they go up, and the nightly
// sync alone misses most of them. So whenever someone has the app open, ask
// for a story-only sync — at most every two hours from any one device.
export function syncStoriesSoon() {
  try {
    const last = Number(localStorage.getItem("ig-story-sync") || 0);
    if (Date.now() - last < 2 * 3600000) return;
    localStorage.setItem("ig-story-sync", String(Date.now()));
  } catch {
    return;
  }
  fetch("/api/instagram-sync?stories=1").catch(() => {});
}

const times2 = (v) => (v == null ? "—" : `${v.toFixed(2)}×`);

const SORTS = [
  { id: "new", label: "Newest", value: (m) => Date.parse(m.posted_at || 0) },
  { id: "rel", label: "Reach vs typical", value: (m) => m._rel ?? -1 },
  { id: "reach", label: "Most reached", value: (m) => m.reach ?? -1 },
  { id: "saves", label: "Saves per 100 reached", value: (m) => per(m.saved, m.reach, 100) ?? -1 },
  { id: "shares", label: "Shares per 100 reached", value: (m) => per(m.shares, m.reach, 100) ?? -1 },
  { id: "watch", label: "Watch time", value: (m) => m.avg_watch_time_ms ?? -1 },
];

function PostsView({ posts, media, narrow, onSelect }) {
  const [sort, setSort] = useState("new");
  const rows = useMemo(() => {
    const withRel = posts.map((m) => ({ ...m, _rel: relativeReach(m, media) }));
    const by = SORTS.find((x) => x.id === sort) || SORTS[0];
    return withRel.sort((a, b) => by.value(b) - by.value(a));
  }, [posts, media, sort]);
  const relColor = (r) => (r == null ? MUTED : r >= 1.4 ? "var(--good)" : r <= 0.7 ? "var(--alert)" : INK);
  // Opening a post keeps its place in this ordering, so "next" means next here.
  const open = (m) => onSelect(posts.find((p) => p.id === m.id) || m);

  return (
    <section className="ig-card">
      <div className="ig-card-head">
        <h3>Every post</h3>
        <label className="ig-sort">
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORTS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </label>
      </div>
      <p className="ig-dim ig-review-sub">
        "vs typical" is reach next to the posts of the same kind from around the same time — 2.0× means twice the usual.
        Open a post to see everything about it.
      </p>
      {narrow ? (
        <div className="ig-post-cards">
          {rows.map((m) => (
            <button key={m.id} className="ig-post-card" onClick={() => open(m)}>
              {m.thumbnail_url || m.media_url ? <img src={m.thumbnail_url || m.media_url} alt="" loading="lazy" /> : <span className="ig-thumb-blank" />}
              <span className="ig-post-card-body">
                <span className="ig-post-card-caption">{(m.caption || "(no caption)").replace(/\s+/g, " ")}</span>
                <span className="ig-dim">{FORMAT_LABEL[formatOf(m)]?.replace(/s$/, "")} · {m.posted_at ? shortDate(m.posted_at) : "—"} {m.posted_at ? new Date(m.posted_at).getFullYear() : ""}</span>
                <span className="ig-post-card-stats">
                  <span><Users size={11} /> {compact(m.reach)}</span>
                  <span><Eye size={11} /> {compact(m.views)}</span>
                  <span style={{ color: relColor(m._rel) }}>{times2(m._rel)}</span>
                  {m.avg_watch_time_ms ? <span><Play size={11} /> {watchTime(m.avg_watch_time_ms)}</span> : null}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="ig-table-scroll">
          <table className="ig-table">
            <thead>
              <tr>
                <th>Post</th><th>Type</th><th>Date</th>
                <th className="num">Views</th><th className="num">Reach</th><th className="num">vs typical</th>
                <th className="num">Likes</th><th className="num">Comments</th>
                <th className="num">Saves</th><th className="num">Shares</th>
                <th className="num">Eng. rate</th><th className="num">Avg watch</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className="ig-row-click" onClick={() => open(m)}>
                  <td className="ig-post-cell">
                    {m.thumbnail_url || m.media_url ? (
                      <img src={m.thumbnail_url || m.media_url} alt="" loading="lazy" />
                    ) : <span className="ig-thumb-blank" />}
                    <span className="ig-post-caption">
                      {(m.caption || "(no caption)").replace(/\s+/g, " ").slice(0, 60)}
                    </span>
                  </td>
                  <td>{FORMAT_LABEL[formatOf(m)]?.replace(/s$/, "")}</td>
                  <td>{m.posted_at ? shortDate(m.posted_at) : "—"}</td>
                  <td className="num">{full(m.views)}</td>
                  <td className="num">{full(m.reach)}</td>
                  <td className="num" style={{ color: relColor(m._rel) }}>{times2(m._rel)}</td>
                  <td className="num">{full(m.likes)}</td>
                  <td className="num">{full(m.comments)}</td>
                  <td className="num">{full(m.saved)}</td>
                  <td className="num">{full(m.shares)}</td>
                  <td className="num">{pct(engagementRate(m))}</td>
                  <td className="num">{watchTime(m.avg_watch_time_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!posts.length ? <div className="ig-empty-chart">No posts in this range.</div> : null}
    </section>
  );
}

// Cell colour: how far above or below typical reach the slot runs. One hue,
// stronger for better; below-typical slots fade toward the surface rather than
// switching hue, so the map reads at a glance without a legend for two colours.
function cellStyle(cell) {
  if (cell.n < 3 || cell.value == null) return { background: "transparent", color: MUTED };
  const t = Math.max(0, Math.min(1, (cell.value - 0.5) / 1.5)); // 0.5x .. 2x
  return { background: `rgba(176,139,51,${(0.08 + t * 0.72).toFixed(2)})`, color: t > 0.55 ? "#171812" : INK };
}

function TimingView({ times, formats, onSelect }) {
  const [picked, setPicked] = useState(null); // { di, bi }
  const cell = picked ? times.grid[picked.di][picked.bi] : null;
  const formatRows = formats.map((f) => ({ id: f.format, label: `${f.label} (${f.n})`, value: f.relReach }));

  return (
    <>
      <section className="ig-card">
        <h3>Best time to post</h3>
        <p className="ig-dim ig-review-sub">
          Each square is how posts that went out then did on reach, next to the posts from around the same time —
          1.30× means 30% more than usual. Based on {times.posts} posts{times.since ? ` since ${new Date(times.since).getFullYear()}` : ""}, in this device's time zone.
          Squares with fewer than 3 posts are left blank. Tap one to see its posts.
        </p>
        <div className="ig-heat-scroll">
          <table className="ig-heat">
            <thead>
              <tr><th />{TIME_BLOCKS.map((b) => <th key={b.label}>{b.label}</th>)}</tr>
            </thead>
            <tbody>
              {times.grid.map((row, di) => (
                <tr key={DAY_NAMES[di]}>
                  <th>{DAY_NAMES[di]}</th>
                  {row.map((c, bi) => (
                    <td key={bi}>
                      <button
                        className={`ig-heat-cell${picked && picked.di === di && picked.bi === bi ? " on" : ""}`}
                        style={cellStyle(c)}
                        onClick={() => setPicked(c.n ? { di, bi } : null)}
                        title={`${c.n} posts`}
                      >
                        {c.n >= 3 && c.value != null ? times2(c.value) : c.n ? <span className="ig-heat-n">{c.n}</span> : ""}
                      </button>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {times.best.length ? (
          <p style={{ margin: "12px 0 0", fontSize: 13 }}>
            Strongest: {times.best.map((b) => `${DAY_NAMES[b.di]} ${TIME_BLOCKS[b.bi].label} (${times2(b.value)}, ${b.n} posts)`).join(" · ")}.
            {times.worst.length ? <span className="ig-dim"> Weakest: {times.worst.map((b) => `${DAY_NAMES[b.di]} ${TIME_BLOCKS[b.bi].label} (${times2(b.value)})`).join(" · ")}.</span> : null}
          </p>
        ) : <p className="ig-dim">Not enough posts with numbers yet to compare times.</p>}
        {cell ? (
          <div className="ig-best-row" style={{ marginTop: 12 }}>
            {cell.posts.sort((a, b) => b.posted_at.localeCompare(a.posted_at)).slice(0, 12).map((m) => (
              <button key={m.id} className="ig-best" onClick={() => onSelect(m)}>
                {m.thumbnail_url || m.media_url ? <img src={m.thumbnail_url || m.media_url} alt="" loading="lazy" /> : <span className="ig-thumb-blank" />}
                <span className="ig-best-num">{compact(m.reach)} reached</span>
                <span className="ig-dim">{shortDate(m.posted_at)} {new Date(m.posted_at).getFullYear()}</span>
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <section className="ig-card">
        <h3>Reels, carousels or photos?</h3>
        <p className="ig-dim ig-review-sub">
          The last 40 posts of each format, compared on the same footing: reach next to the posts from around the
          same time. A format can only win here on how it does, not on when it happened to be used.
        </p>
        <BarChart rows={formatRows} valueFormat={times2} color={SERIES[1]} />
        <div className="ig-table-scroll" style={{ marginTop: 12 }}>
          <table className="ig-table">
            <thead>
              <tr><th>Format</th><th className="num">Posts</th><th className="num">Reach vs typical</th><th className="num">Reach</th><th className="num">Views</th><th className="num">Saves /100</th><th className="num">Shares /100</th><th className="num">Eng. rate</th></tr>
            </thead>
            <tbody>
              {formats.map((f) => (
                <tr key={f.format}>
                  <td>{f.label}</td>
                  <td className="num">{f.n}{f.since ? <span className="ig-dim"> since {new Date(f.since).getFullYear()}</span> : null}</td>
                  <td className="num">{times2(f.relReach)}</td>
                  <td className="num">{full(f.reach)}</td>
                  <td className="num">{full(f.views)}</td>
                  <td className="num">{f.saves == null ? "—" : f.saves.toFixed(2)}</td>
                  <td className="num">{f.shares == null ? "—" : f.shares.toFixed(2)}</td>
                  <td className="num">{pct(f.engagement)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/* ------------------------------ the main view ----------------------------- */
const RANGES = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

export default function Analytics({ profile }) {
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState("");
  const [tab, setTab] = useState("charts");
  const [kind, setKind] = useState("ALL");
  const [demoBreak, setDemoBreak] = useState("country");
  const [selected, setSelected] = useState(null); // the post opened in PostReview
  const closeReview = useCallback(() => setSelected(null), []);
  const { loading, media, account, demo, error, reload } = useInstagramData(days);

  useEffect(() => {
    fetch("/api/instagram-status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({ configured: false, reason: "Couldn't reach the server." }));
  }, []);

  // The OAuth callback can only talk back through the URL it redirects to, so
  // whatever Facebook or the callback had to say arrives as ?ig=. Without this
  // a failed connect looks identical to never having pressed the button --
  // the reason sits unread in the address bar.
  const [connectResult, setConnectResult] = useState(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("ig");
    if (!outcome) return;
    setConnectResult(
      outcome === "connected"
        ? { ok: true, text: `Connected ${params.get("name") || "your account"}. Run a sync to pull the numbers.` }
        : { ok: false, text: params.get("why") || "Instagram couldn't be connected." }
    );
    // Clear the params so a refresh does not re-announce a stale result.
    const url = new URL(window.location.href);
    url.search = "";
    window.history.replaceState({}, "", url);
  }, []);

  const connected = status?.accounts?.[0];

  const runSync = async () => {
    setSyncing(true);
    setSyncNote("");
    try {
      const res = await fetch("/api/instagram-sync");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Sync failed.");
      const r = json.reports?.[0];
      setSyncNote(r
        ? `Synced ${r.mediaSeen} posts · ${r.insightsSaved} updated${r.errors?.length ? ` · ${r.errors[0]}` : ""}`
        : json.note || "Done.");
      reload();
      fetch("/api/instagram-status").then((x) => x.json()).then(setStatus).catch(() => {});
    } catch (err) {
      setSyncNote(err.message);
    }
    setSyncing(false);
  };

  /* Today's row only has the follower total until the next morning's sync
     fills in its views and reach, so it would end every chart on a fake drop.
     The window is the last `days` complete days; the one before it, of equal
     length, is what "vs previous period" compares against. */
  const { current, previous } = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const complete = account.filter((r) => r.day < today);
    const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return { current: complete.filter((r) => r.day >= start), previous: complete.filter((r) => r.day < start) };
  }, [account, days]);

  /* Account series. Views and reach share one axis because they are the same
     unit (counts) -- a second y-scale would invent a correlation. Followers
     are a different unit entirely, so they get their own chart. */
  const accountSeries = useMemo(() => ([
    { label: "Views", color: SERIES[0], points: current.map((r) => ({ day: r.day, value: r.views })) },
    { label: "Reach", color: SERIES[1], points: current.map((r) => ({ day: r.day, value: r.reach })) },
  ].filter((s) => s.points.some((p) => p.value != null))), [current]);

  // The total is only recorded from the day of connecting, so for the first
  // weeks the useful chart is how many people followed each day.
  const followerSeries = useMemo(() => ([
    { label: "New followers", color: SERIES[0], points: current.map((r) => ({ day: r.day, value: r.new_followers })) },
  ].filter((s) => s.points.some((p) => p.value != null))), [current]);

  // Headline numbers. A change is only shown when both periods are mostly
  // there: a 30-day window set against 4 recorded days is not a comparison.
  const totals = useMemo(() => {
    const sum = (rows, k) => rows.reduce((acc, r) => acc + (r[k] || 0), 0);
    const covered = (rows, k) => rows.filter((r) => r[k] != null).length;
    const delta = (k) => {
      if (covered(current, k) < days * 0.8 || covered(previous, k) < days * 0.8) return null;
      const before = sum(previous, k);
      return before ? ((sum(current, k) - before) / before) * 100 : null;
    };
    const withTotal = account.filter((r) => r.followers != null);
    const followers = withTotal.length ? withTotal[withTotal.length - 1].followers : null;
    // Net change from the recorded totals, where the window has them; Meta's
    // daily figure only counts new follows, never unfollows.
    const inWindow = withTotal.filter((r) => r.day >= (current[0]?.day || ""));
    const net = inWindow.length >= 2 ? inWindow[inWindow.length - 1].followers - inWindow[0].followers : null;
    return {
      followers,
      net,
      netSince: inWindow[0]?.day || null,
      gained: covered(current, "new_followers") ? sum(current, "new_followers") : null,
      views: sum(current, "views"),
      viewsDelta: delta("views"),
      reach: sum(current, "reach"),
      reachDelta: delta("reach"),
      profileViews: sum(current, "profile_views"),
      profileViewsDelta: delta("profile_views"),
    };
  }, [account, current, previous, days]);

  const inRange = useMemo(() => {
    const cutoff = Date.now() - days * 86400000;
    return media.filter((m) => {
      if (Date.parse(m.posted_at || 0) < cutoff) return false;
      if (kind === "ALL") return true;
      if (kind === "REELS") return m.media_product_type === "REELS";
      if (kind === "STORY") return m.media_product_type === "STORY";
      return m.media_product_type !== "REELS" && m.media_product_type !== "STORY";
    });
  }, [media, days, kind]);

  const topPosts = useMemo(() => (
    [...inRange]
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, 8)
      .map((m) => ({
        id: m.id,
        label: (m.caption || "(no caption)").replace(/\s+/g, " ").trim(),
        value: m.views || 0,
        sub: `${shortDate(m.posted_at)} · ${full(m.likes)} likes · ${full(m.comments)} comments · click for details`,
        post: m,
      }))
  ), [inRange]);

  const demoRows = useMemo(() => (
    demo.filter((d) => d.breakdown === demoBreak)
      .sort((a, b) => b.value - a.value).slice(0, 10)
      .map((d) => ({ id: `${d.breakdown}-${d.label}`, label: d.label, value: d.value }))
  ), [demo, demoBreak]);

  const times = useMemo(() => postingTimes(media), [media]);
  const formats = useMemo(() => formatComparison(media), [media]);
  const narrow = useNarrow();

  // Content Review's "Open in Analytics" leaves the post it was about here.
  useEffect(() => {
    if (!media.length) return;
    let wanted = null;
    try { wanted = sessionStorage.getItem("ig-open-post"); sessionStorage.removeItem("ig-open-post"); } catch { /* private mode */ }
    const post = wanted && media.find((m) => m.id === wanted);
    if (post) setSelected(post);
  }, [media]);
  useEffect(() => { syncStoriesSoon(); }, []);

  /* ------------------------------ empty states ---------------------------- */
  if (status && !status.configured) {
    return (
      <div className="ig-root">
        <Header />
        <ConnectNote />
        <div className="ig-setup">
          <AlertTriangle size={18} />
          <div>
            <strong>Instagram isn't connected yet.</strong>
            <p>{status.reason}</p>
            <p className="ig-dim">
              Add the environment variables in Vercel → Settings → Environment Variables,
              then reload. Setup steps are in README-instagram.md.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status && !connected) {
    return (
      <div className="ig-root">
        <Header />
        <ConnectNote />
        <div className="ig-connect">
          <Instagram size={28} strokeWidth={1.5} />
          <h3 className="display">Connect your Instagram account</h3>
          <p>
            Pulls views, reach, likes, saves, shares and watch time for every post
            and reel, then keeps a daily record so you can see how things grow.
          </p>
          <p className="ig-dim">
            Instagram only reports a post's numbers as they are right now — it keeps no
            history. The daily record starts the day you connect, so the sooner this is
            on, the more you will be able to look back on.
          </p>
          <a className="btn btn-gold" href={`/api/instagram-connect?profile=${encodeURIComponent(profile || "")}`}>
            <Instagram size={15} /> Connect Instagram
          </a>
        </div>
      </div>
    );
  }

  // Declared as a function so it hoists above the early returns below, which
  // need it too: a failed connect lands on the "not connected yet" screen, and
  // that is exactly where the reason has to be readable.
  function ConnectNote() {
    if (!connectResult) return null;
    return (
      <div className={`ig-note${connectResult.ok ? "" : " ig-note-bad"}`}>
        {connectResult.ok ? <Check size={14} /> : <AlertTriangle size={14} />}
        {connectResult.text}
      </div>
    );
  }

  function Header() {
    return (
      <div className="ig-head">
        <div>
          <h2 className="display">Instagram analytics</h2>
          {connected ? (
            <p className="ig-dim">
              @{connected.username}
              {connected.last_synced_at
                ? ` · last synced ${new Date(connected.last_synced_at).toLocaleString()}`
                : " · never synced"}
            </p>
          ) : null}
        </div>
        <div className="ig-head-actions">
          <button className="btn btn-ghost" onClick={runSync} disabled={syncing}>
            <RefreshCw size={14} className={syncing ? "ig-spin" : ""} />
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ig-root">
      <Header />
        <ConnectNote />

      {syncNote ? <div className="ig-note">{syncNote}</div> : null}
      {error ? <div className="ig-note ig-note-bad"><AlertTriangle size={14} /> {error}</div> : null}
      {connected?.last_sync_error ? (
        <div className="ig-note ig-note-bad">
          <AlertTriangle size={14} /> Last sync reported: {connected.last_sync_error}
        </div>
      ) : null}
      {connected?.daysUntilExpiry != null && connected.daysUntilExpiry < 10 ? (
        <div className="ig-note ig-note-bad">
          <AlertTriangle size={14} /> This connection expires in {connected.daysUntilExpiry} days.
          Reconnect to keep collecting.{" "}
          <a href={`/api/instagram-connect?profile=${encodeURIComponent(profile || "")}`}>Reconnect</a>
        </div>
      ) : null}

      {/* Filters in one row above the charts */}
      <div className="ig-filters">
        <div className="ig-seg">
          {RANGES.map((r) => (
            <button key={r.days} className={days === r.days ? "on" : ""} onClick={() => setDays(r.days)}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="ig-seg">
          {[["ALL", "All"], ["FEED", "Posts"], ["REELS", "Reels"], ["STORY", "Stories"]].map(([v, l]) => (
            <button key={v} className={kind === v ? "on" : ""} onClick={() => setKind(v)}>{l}</button>
          ))}
        </div>
        <div className="ig-seg ig-seg-right">
          <button className={tab === "charts" ? "on" : ""} onClick={() => setTab("charts")}>
            <BarChart3 size={13} /> Overview
          </button>
          <button className={tab === "table" ? "on" : ""} onClick={() => setTab("table")}>
            <Table2 size={13} /> Posts
          </button>
          <button className={tab === "timing" ? "on" : ""} onClick={() => setTab("timing")}>
            <Clock size={13} /> When & what
          </button>
          <button className={tab === "video" ? "on" : ""} onClick={() => setTab("video")}>
            <Film size={13} /> Video check
          </button>
        </div>
      </div>

      {loading && tab !== "video" ? <div className="ig-empty-chart">Loading…</div> : null}

      {!loading && !account.length && !media.length && !error && tab !== "video" ? (
        <div className="ig-connect">
          <Instagram size={26} strokeWidth={1.5} />
          <h3 className="display">No data collected yet</h3>
          <p>Run the first sync to pull your posts and up to 90 days of account history.</p>
          <button className="btn btn-gold" onClick={runSync} disabled={syncing}>
            <RefreshCw size={14} className={syncing ? "ig-spin" : ""} /> Run first sync
          </button>
        </div>
      ) : null}

      {tab === "video" ? <VideoCheck media={media} /> : null}

      {!loading && (account.length > 0 || media.length > 0) && tab !== "video" ? (
        <>
          {/* The one hero figure for this view. */}
          {totals.followers != null ? (
            <div className="ig-hero">
              <div className="ig-hero-label">Followers</div>
              <div className="ig-hero-value">{full(totals.followers)}</div>
              {totals.net != null ? (
                <div className="ig-hero-delta" style={{ color: totals.net > 0 ? "var(--good)" : totals.net < 0 ? "var(--alert)" : MUTED }}>
                  {totals.net > 0 ? <ArrowUpRight size={15} /> : totals.net < 0 ? <ArrowDownRight size={15} /> : null}
                  {totals.net === 0 ? "No change" : `${totals.net > 0 ? "+" : "−"}${full(Math.abs(totals.net))}`} since {shortDate(totals.netSince)}
                  <span className="ig-dim" style={{ marginLeft: 6 }}>(totals are recorded from the day of connecting)</span>
                </div>
              ) : null}
              {totals.gained != null ? (
                <div className="ig-dim" style={{ marginTop: 4 }}>
                  {full(totals.gained)} new follows in the last {days} days — unfollows aren't counted in this one
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="ig-tiles">
            <StatTile label="Views" value={compact(totals.views)} delta={totals.viewsDelta}
              deltaLabel={totals.viewsDelta == null ? "not enough history to compare yet" : `vs the ${days} days before`} icon={Eye}
              spark={current.map((r) => r.views).filter((v) => v != null)} />
            <StatTile label="Daily reach, added up" value={compact(totals.reach)} delta={totals.reachDelta}
              deltaLabel={totals.reachDelta == null ? "not enough history to compare yet" : `vs the ${days} days before`} icon={Users}
              spark={current.map((r) => r.reach).filter((v) => v != null)} />
            <StatTile label="Profile views" value={compact(totals.profileViews)} delta={totals.profileViewsDelta}
              deltaLabel={totals.profileViewsDelta == null ? "not enough history to compare yet" : `vs the ${days} days before`} icon={ExternalLink}
              spark={current.map((r) => r.profile_views).filter((v) => v != null)} />
            <StatTile label="Posts in range" value={full(inRange.length)} deltaLabel={`last ${days} days`} icon={Play} />
          </div>

          {tab === "charts" ? (
            <>
              {followerSeries.length ? (
                <section className="ig-card">
                  <h3>New followers per day</h3>
                  <LineChart series={followerSeries} valueFormat={full} />
                </section>
              ) : null}

              {accountSeries.length ? (
                <section className="ig-card">
                  <h3>Views and reach per day</h3>
                  <Legend series={accountSeries} />
                  <LineChart series={accountSeries} />
                </section>
              ) : null}

              <section className="ig-card">
                <h3>Top posts by views</h3>
                <BarChart rows={topPosts} onRowClick={(r) => setSelected(r.post)} />
              </section>

              {demoRows.length ? (
                <section className="ig-card">
                  <div className="ig-card-head">
                    <h3>Audience</h3>
                    <div className="ig-seg">
                      {["country", "city", "age", "gender"].map((b) => (
                        <button key={b} className={demoBreak === b ? "on" : ""} onClick={() => setDemoBreak(b)}>
                          {b[0].toUpperCase() + b.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <BarChart rows={demoRows} color={SERIES[1]} />
                </section>
              ) : null}
            </>
          ) : tab === "table" ? (
            <PostsView posts={inRange} media={media} narrow={narrow} onSelect={setSelected} />
          ) : (
            <TimingView times={times} formats={formats} onSelect={setSelected} />
          )}
        </>
      ) : null}

      {selected ? (
        <PostReview
          post={selected} media={media} times={times}
          list={inRange.some((m) => m.id === selected.id) ? inRange : media}
          onSelect={setSelected} onClose={closeReview}
        />
      ) : null}
    </div>
  );
}

// Re-exported so App.jsx can put this screen in the nav without adding another
// name to its lucide import block -- one less line of shared file to touch.
export { BarChart3 as AnalyticsIcon };
