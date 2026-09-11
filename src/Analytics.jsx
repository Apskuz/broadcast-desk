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
  AlertTriangle, Eye, Users, Play, Table2, BarChart3,
} from "lucide-react";
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

/* ------------------------------- data loading ----------------------------- */
function useInstagramData(days) {
  const [state, setState] = useState({ loading: true, media: [], account: [], demo: [], error: null });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    try {
      const [mediaRes, acctRes, demoRes] = await Promise.all([
        supabase.from("ig_media_latest").select("*").order("posted_at", { ascending: false }).limit(400),
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
  const { loading, media, account, demo, error, reload } = useInstagramData(days);

  useEffect(() => {
    fetch("/api/instagram-status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({ configured: false, reason: "Couldn't reach the server." }));
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

  /* Account series. Views and reach share one axis because they are the same
     unit (counts) -- a second y-scale would invent a correlation. Followers
     are a different unit entirely, so they get their own chart. */
  const accountSeries = useMemo(() => ([
    { label: "Views", color: SERIES[0], points: account.map((r) => ({ day: r.day, value: r.views })) },
    { label: "Reach", color: SERIES[1], points: account.map((r) => ({ day: r.day, value: r.reach })) },
  ].filter((s) => s.points.some((p) => p.value != null))), [account]);

  const followerSeries = useMemo(() => ([
    { label: "Followers", color: SERIES[0], points: account.map((r) => ({ day: r.day, value: r.followers })) },
  ].filter((s) => s.points.some((p) => p.value != null))), [account]);

  // Headline numbers, each compared against the preceding window of equal length.
  const totals = useMemo(() => {
    const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
    const half = Math.floor(account.length / 2);
    const prev = account.slice(0, half);
    const curr = account.slice(half);
    const delta = (k) => {
      const p = sum(prev, k);
      const c = sum(curr, k);
      if (!p || !prev.length || !curr.length) return null;
      return ((c - p) / p) * 100;
    };
    const followers = [...account].reverse().find((r) => r.followers != null)?.followers ?? null;
    const firstFollowers = account.find((r) => r.followers != null)?.followers ?? null;
    return {
      followers,
      followerDelta: firstFollowers && followers ? ((followers - firstFollowers) / firstFollowers) * 100 : null,
      views: sum(account, "views"),
      viewsDelta: delta("views"),
      reach: sum(account, "reach"),
      reachDelta: delta("reach"),
      profileViews: sum(account, "profile_views"),
      profileViewsDelta: delta("profile_views"),
    };
  }, [account]);

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
        sub: `${shortDate(m.posted_at)} · ${full(m.likes)} likes · ${full(m.comments)} comments`,
        permalink: m.permalink,
      }))
  ), [inRange]);

  const demoRows = useMemo(() => (
    demo.filter((d) => d.breakdown === demoBreak)
      .sort((a, b) => b.value - a.value).slice(0, 10)
      .map((d) => ({ id: `${d.breakdown}-${d.label}`, label: d.label, value: d.value }))
  ), [demo, demoBreak]);

  const engagement = (m) => {
    if (!m.reach) return null;
    const interactions = m.total_interactions ?? ((m.likes || 0) + (m.comments || 0) + (m.saved || 0) + (m.shares || 0));
    return (interactions / m.reach) * 100;
  };

  /* ------------------------------ empty states ---------------------------- */
  if (status && !status.configured) {
    return (
      <div className="ig-root">
        <Header />
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
            <BarChart3 size={13} /> Charts
          </button>
          <button className={tab === "table" ? "on" : ""} onClick={() => setTab("table")}>
            <Table2 size={13} /> Table
          </button>
        </div>
      </div>

      {loading ? <div className="ig-empty-chart">Loading…</div> : null}

      {!loading && !account.length && !media.length ? (
        <div className="ig-connect">
          <Instagram size={26} strokeWidth={1.5} />
          <h3 className="display">No data collected yet</h3>
          <p>Run the first sync to pull your posts and up to 90 days of account history.</p>
          <button className="btn btn-gold" onClick={runSync} disabled={syncing}>
            <RefreshCw size={14} className={syncing ? "ig-spin" : ""} /> Run first sync
          </button>
        </div>
      ) : null}

      {!loading && (account.length > 0 || media.length > 0) ? (
        <>
          {/* The one hero figure for this view. */}
          {totals.followers != null ? (
            <div className="ig-hero">
              <div className="ig-hero-label">Followers</div>
              <div className="ig-hero-value">{full(totals.followers)}</div>
              {totals.followerDelta != null ? (
                <div className="ig-hero-delta" style={{ color: totals.followerDelta >= 0 ? "var(--good)" : "var(--alert)" }}>
                  {totals.followerDelta >= 0 ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}
                  {Math.abs(totals.followerDelta).toFixed(1)}% over {days} days
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="ig-tiles">
            <StatTile label="Views" value={compact(totals.views)} delta={totals.viewsDelta}
              deltaLabel="vs previous period" icon={Eye}
              spark={account.map((r) => r.views).filter((v) => v != null)} />
            <StatTile label="Reach" value={compact(totals.reach)} delta={totals.reachDelta}
              deltaLabel="vs previous period" icon={Users}
              spark={account.map((r) => r.reach).filter((v) => v != null)} />
            <StatTile label="Profile views" value={compact(totals.profileViews)} delta={totals.profileViewsDelta}
              deltaLabel="vs previous period" icon={ExternalLink}
              spark={account.map((r) => r.profile_views).filter((v) => v != null)} />
            <StatTile label="Posts in range" value={full(inRange.length)} deltaLabel={`last ${days} days`} icon={Play} />
          </div>

          {tab === "charts" ? (
            <>
              {followerSeries.length ? (
                <section className="ig-card">
                  <h3>Followers over time</h3>
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
                <BarChart rows={topPosts}
                  onRowClick={(r) => r.permalink && window.open(r.permalink, "_blank", "noopener")} />
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
          ) : (
            <section className="ig-card">
              <h3>Every post</h3>
              <div className="ig-table-scroll">
                <table className="ig-table">
                  <thead>
                    <tr>
                      <th>Post</th><th>Type</th><th>Date</th>
                      <th className="num">Views</th><th className="num">Reach</th>
                      <th className="num">Likes</th><th className="num">Comments</th>
                      <th className="num">Saves</th><th className="num">Shares</th>
                      <th className="num">Eng. rate</th><th className="num">Avg watch</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inRange.map((m) => (
                      <tr key={m.id}>
                        <td className="ig-post-cell">
                          {m.thumbnail_url || m.media_url ? (
                            <img src={m.thumbnail_url || m.media_url} alt="" loading="lazy" />
                          ) : <span className="ig-thumb-blank" />}
                          <a href={m.permalink} target="_blank" rel="noreferrer">
                            {(m.caption || "(no caption)").replace(/\s+/g, " ").slice(0, 60)}
                          </a>
                        </td>
                        <td>{m.media_product_type || m.media_type}</td>
                        <td>{m.posted_at ? shortDate(m.posted_at) : "—"}</td>
                        <td className="num">{full(m.views)}</td>
                        <td className="num">{full(m.reach)}</td>
                        <td className="num">{full(m.likes)}</td>
                        <td className="num">{full(m.comments)}</td>
                        <td className="num">{full(m.saved)}</td>
                        <td className="num">{full(m.shares)}</td>
                        <td className="num">{pct(engagement(m))}</td>
                        <td className="num">{watchTime(m.avg_watch_time_ms)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!inRange.length ? <div className="ig-empty-chart">No posts in this range.</div> : null}
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}

// Re-exported so App.jsx can put this screen in the nav without adding another
// name to its lucide import block -- one less line of shared file to touch.
export { BarChart3 as AnalyticsIcon };
