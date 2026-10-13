// The "what should we make next" screens of Analytics: What works (themes,
// series, hooks, follower conversion, retention), Tests, Brief (with what
// people ask in the comments) and Team. Everything is computed from the
// team's own posts in the browser — nothing here costs anything to run.
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";
import { loadMedia } from "./IgPostLink";
import { Plus, X, Check, AlertTriangle, ArrowUpRight, ArrowDownRight, FlaskConical, ListChecks, MessageSquare, RefreshCw, Pencil, EyeOff } from "lucide-react";
import { kindOf, postingTimes } from "./igInsights";
import {
  themesOf, suggestThemes, themeStats, detectSeries, hookStats, conversion, experimentResults, EXPERIMENT_PRESETS,
  retentionPatterns, RETENTION_MIN, peopleStats, commentInsights, buildBrief, predictReach, quietEffect,
} from "./igLearn";

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const x2 = (v) => (v == null ? "—" : `${v.toFixed(2)}×`);
const n2 = (v, d = 2) => (v == null ? "—" : v.toFixed(d));
const relColor = (r) => (r == null ? "var(--muted)" : r >= 1.2 ? "var(--good)" : r <= 0.8 ? "var(--alert)" : "var(--text)");
const thumb = (m) => m.thumbnail_url || m.media_url;
const firstLine = (m) => (m.caption || "(no caption)").split("\n")[0].slice(0, 90);
const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function PostStrip({ posts, onSelect, label }) {
  if (!posts.length) return null;
  return (
    <div className="ig-best-row" style={{ marginTop: 10 }}>
      {posts.slice(0, 12).map(({ post, sub }) => (
        <button key={post.id} className="ig-best" onClick={() => onSelect(post)}>
          {thumb(post) ? <img src={thumb(post)} alt="" loading="lazy" /> : <span className="ig-thumb-blank" />}
          <span className="ig-best-num">{sub}</span>
          <span className="ig-dim">{new Date(post.posted_at).toLocaleDateString(undefined, { month: "short", year: "numeric" })}</span>
        </button>
      ))}
      {label ? <span className="ig-dim">{label}</span> : null}
    </div>
  );
}

// Reach next to typical for each episode, as a tiny line.
function Trend({ values }) {
  const v = values.filter((x) => x != null);
  if (v.length < 2) return null;
  const w = 120; const h = 28;
  const max = Math.max(2, ...v);
  const pts = v.map((y, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(h - 2 - (y / max) * (h - 4)).toFixed(1)}`).join(" ");
  const one = h - 2 - (1 / max) * (h - 4);
  return (
    <svg width={w} height={h} aria-hidden="true">
      <line x1="0" x2={w} y1={one} y2={one} stroke="rgba(237,235,227,0.18)" strokeWidth="1" />
      <polyline points={pts} fill="none" stroke="#B08B33" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* --------------------------------- What works ------------------------------- */

function Themes({ media, data, saveData, onSelect, brand }) {
  const themes = data?.igThemes || { list: [], manual: {}, off: {} };
  const [open, setOpen] = useState(null);
  const [editing, setEditing] = useState(null); // { id, name, words }
  const [newName, setNewName] = useState("");
  const stats = useMemo(() => themeStats(media, themes), [media, themes]);
  const suggestions = useMemo(() => suggestThemes(media, themes, { brand }), [media, themes, brand]);
  const save = (next) => saveData({ ...data, igThemes: { list: [], manual: {}, off: {}, ...themes, ...next } });
  const addTheme = (name, words) => save({ list: [...themes.list, { id: uid(), name, words }] });
  const removeTheme = (id) => save({ list: themes.list.filter((t) => t.id !== id) });
  const saveEdit = () => {
    if (!editing.name.trim()) return;
    save({ list: themes.list.map((t) => (t.id === editing.id ? { ...t, name: editing.name.trim(), words: editing.words.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean) } : t)) });
    setEditing(null);
  };

  return (
    <section className="ig-card">
      <h3>Themes: what to post about</h3>
      <p className="ig-dim ig-review-sub">
        A theme is a subject you come back to — event invites, testimonies, behind the scenes. Each one has a few words that
        mark a post as belonging to it (from the caption), and you can tag or untag any post by hand from its review.
        Then this ranks them on reach next to your usual.
      </p>
      {suggestions.length ? (
        <div className="in-suggest">
          <span className="ig-dim">Words that keep coming up — tap to make one a theme:</span>
          {suggestions.map((s) => (
            <button key={s.word} className="bm-chip" onClick={() => addTheme(s.name.charAt(0).toUpperCase() + s.name.slice(1), [s.word])} title={`${s.n} posts, ${x2(s.rel)} usual reach`}>
              <Plus size={11} /> {s.name} <span className="ig-dim">{s.n}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="bm-add" style={{ marginTop: 10 }}>
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New theme, e.g. Testimonies" onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) { addTheme(newName.trim(), [newName.trim().toLowerCase()]); setNewName(""); } }} />
        <button className="btn" onClick={() => { if (newName.trim()) { addTheme(newName.trim(), [newName.trim().toLowerCase()]); setNewName(""); } }}><Plus size={13} /> Add theme</button>
      </div>
      {stats.length ? (
        <div className="ig-table-scroll" style={{ marginTop: 12 }}>
          <table className="ig-table">
            <thead><tr><th>Theme</th><th className="num">Posts</th><th className="num">Reach vs usual</th><th className="num">Saves /100</th><th className="num">Shares /100</th><th className="num">Avg watch</th><th /></tr></thead>
            <tbody>
              {stats.map((t) => (
                <React.Fragment key={t.id}>
                  <tr className="ig-row-click" onClick={() => setOpen(open === t.id ? null : t.id)}>
                    <td><strong>{t.name}</strong> <span className="ig-dim">{(t.words || []).join(", ")}</span></td>
                    <td className="num">{t.n}</td>
                    <td className="num" style={{ color: relColor(t.rel) }}>{t.n >= 3 ? x2(t.rel) : "too few"}</td>
                    <td className="num">{n2(t.saves)}</td>
                    <td className="num">{n2(t.shares)}</td>
                    <td className="num">{t.watch == null ? "—" : `${t.watch.toFixed(1)} s`}</td>
                    <td className="num" onClick={(e) => e.stopPropagation()}>
                      <button className="icon-btn" onClick={() => setEditing({ id: t.id, name: t.name, words: (t.words || []).join(", ") })} aria-label="Edit"><Pencil size={12} /></button>
                      <button className="icon-btn" onClick={() => removeTheme(t.id)} aria-label="Remove"><X size={12} /></button>
                    </td>
                  </tr>
                  {editing?.id === t.id ? (
                    <tr><td colSpan={7}>
                      <div className="in-edit">
                        <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Name" />
                        <input value={editing.words} onChange={(e) => setEditing({ ...editing, words: e.target.value })} placeholder="Words that mark it, comma separated" style={{ flex: 2 }} />
                        <button className="btn btn-gold" onClick={saveEdit}><Check size={13} /> Save</button>
                        <button className="btn btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </td></tr>
                  ) : null}
                  {open === t.id ? (
                    <tr><td colSpan={7}>
                      <PostStrip onSelect={onSelect} posts={[...t.posts].sort((a, b) => b.posted_at.localeCompare(a.posted_at)).map((m) => ({ post: m, sub: firstLine(m).slice(0, 26) }))} />
                    </td></tr>
                  ) : null}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="ig-empty-chart" style={{ marginTop: 12 }}>No themes yet — add one above, or tap a suggested word.</div>}
    </section>
  );
}

function Series({ media, data, saveData, onSelect }) {
  const hidden = data?.igSeriesHidden || [];
  const series = useMemo(() => detectSeries(media, hidden), [media, hidden]);
  const [open, setOpen] = useState(null);
  const VERDICT = { growing: "var(--good)", fading: "var(--alert)", steady: "var(--muted)", "too early to tell": "var(--muted)" };
  return (
    <section className="ig-card">
      <h3>Series: recurring formats</h3>
      <p className="ig-dim ig-review-sub">
        Found from posts that open the same way or share a hashtag of their own, three or more times over at least three weeks.
        The line is each episode's reach next to your usual (the faint line is "as usual").
      </p>
      {series.length ? (
        <div className="in-series">
          {series.map((s) => (
            <div key={s.key} className="in-series-card">
              <button className="in-series-head" onClick={() => setOpen(open === s.key ? null : s.key)}>
                <span><strong>{s.label}</strong><span className="ig-dim"> · {s.episodes.length} episodes · last {shortDate(s.last)}</span></span>
                <Trend values={s.rels} />
                <span style={{ color: VERDICT[s.verdict], fontWeight: 600 }}>{s.verdict}{s.trend ? ` (${x2(s.trend)})` : ""}</span>
              </button>
              {open === s.key ? (
                <>
                  <PostStrip onSelect={onSelect} posts={s.episodes.slice(-12).reverse().map((m, i) => ({ post: m, sub: x2(s.rels[s.rels.length - 1 - i]) }))} />
                  <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => saveData({ ...data, igSeriesHidden: [...hidden, s.key] })}><EyeOff size={13} /> Not a series</button>
                </>
              ) : null}
            </div>
          ))}
        </div>
      ) : <div className="ig-empty-chart">No recurring formats found yet.</div>}
      {hidden.length ? <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => saveData({ ...data, igSeriesHidden: [] })}>Show {hidden.length} hidden</button> : null}
    </section>
  );
}

function Hooks({ media, content, onSelect }) {
  const h = useMemo(() => hookStats(media, content), [media, content]);
  const Row = ({ r }) => (
    <li className="ig-row-click" onClick={() => onSelect(r.post)}>
      <span className="in-hook-rel" style={{ color: relColor(r.rel) }}>{x2(r.rel)}</span>
      <span>
        {r.hook || <span className="ig-dim">(no caption)</span>}
        {r.spoken ? <span className="ig-dim"> · said: “{r.spoken.slice(0, 90)}”</span> : null}
        {r.watch ? <span className="ig-dim"> · watched {r.watch.toFixed(1)} s</span> : null}
      </span>
    </li>
  );
  return (
    <section className="ig-card">
      <h3>Hooks: how posts open</h3>
      <p className="ig-dim ig-review-sub">The first line of each caption (and the first words spoken, for uploads that were transcribed), ranked by reach next to your usual. Copy from the top, avoid the bottom.</p>
      {h.patterns.length ? (
        <ul className="ig-advice" style={{ marginBottom: 12 }}>
          {h.patterns.map((p) => (
            <li key={p.label}>
              <strong>{p.label}:</strong>{" "}
              <span style={{ color: relColor(p.ratio) }}>{x2(p.ratio)}</span> the reach of posts without it ({p.yes} vs {p.no} posts).
            </li>
          ))}
        </ul>
      ) : null}
      <div className="ig-review-pair">
        <div>
          <h4 className="in-h4"><ArrowUpRight size={14} /> Best openings</h4>
          <ul className="in-hooks">{h.best.map((r) => <Row key={r.post.id} r={r} />)}</ul>
        </div>
        <div>
          <h4 className="in-h4"><ArrowDownRight size={14} /> Weakest openings</h4>
          <ul className="in-hooks">{h.worst.map((r) => <Row key={r.post.id} r={r} />)}</ul>
        </div>
      </div>
    </section>
  );
}

function Conversion({ media, account, onSelect }) {
  const c = useMemo(() => conversion(media, account), [media, account]);
  return (
    <section className="ig-card">
      <h3>Which posts turn viewers into followers</h3>
      <p className="ig-dim ig-review-sub">
        Follows per 1,000 accounts reached. Instagram counts follows for feed posts; for reels it doesn't, so theirs (marked ≈) are
        estimated from the new followers on the day they went out and the day after, shared by reach.
      </p>
      {c.byFormat.length ? (
        <div className="in-facts">
          {c.byFormat.map((g) => <span key={g.format}><b>{g.label}</b> {g.per1000.toFixed(1)} per 1,000 ({g.n})</span>)}
        </div>
      ) : null}
      <PostStrip onSelect={onSelect} posts={c.rows.slice(0, 8).map((r) => ({ post: r.post, sub: `${r.estimated ? "≈ " : ""}${r.per1000.toFixed(1)} / 1,000` }))} />
      {!c.rows.length ? <div className="ig-empty-chart">Not enough follower data yet.</div> : null}
    </section>
  );
}

function Retention({ media, content }) {
  const r = useMemo(() => retentionPatterns(content, media), [content, media]);
  const pctOf = (v) => `${Math.round(v * 100)}%`;
  return (
    <section className="ig-card">
      <h3>What keeps people watching</h3>
      <p className="ig-dim ig-review-sub">
        From videos checked when they were uploaded and later linked to their reel (Content Review → Published): how far people watched,
        set against what the check measured. Instagram itself has no watch-through curve to give.
      </p>
      {r.rows.length < RETENTION_MIN ? (
        <div className="ig-empty-chart">
          {r.rows.length} of {RETENTION_MIN} needed. Each video uploaded through Content Review is checked automatically — link it to its
          Instagram post once it's out, and this fills in.
        </div>
      ) : r.patterns.length ? (
        <ul className="ig-advice">
          {r.patterns.map((p) => (
            <li key={p.name}>
              <strong>{p.name}</strong> of {Math.round(p.split * 10) / 10} or less: watched {pctOf(p.low)} through on average; more than that: {pctOf(p.high)}.
            </li>
          ))}
        </ul>
      ) : <div className="ig-empty-chart">Across {r.rows.length} videos, nothing measured makes a clear difference yet.</div>}
    </section>
  );
}

export function WhatWorks({ media, data, saveData, account, onSelect, brand }) {
  const content = data?.content || [];
  return (
    <>
      <Themes media={media} data={data} saveData={saveData} onSelect={onSelect} brand={brand} />
      <Series media={media} data={data} saveData={saveData} onSelect={onSelect} />
      <Hooks media={media} content={content} onSelect={onSelect} />
      <Conversion media={media} account={account} onSelect={onSelect} />
      <Retention media={media} content={content} />
    </>
  );
}

/* ----------------------------------- Tests ---------------------------------- */

// On a post's review: mark it as a test of one change.
export function TestMarker({ post, data, saveData, profile }) {
  const tests = (data?.igExperiments || []).filter((e) => e.mediaId === post.id);
  const [change, setChange] = useState("");
  if (!saveData) return null;
  const add = () => {
    const c = change.trim();
    if (!c) return;
    saveData({ ...data, igExperiments: [...(data.igExperiments || []), { id: uid(), mediaId: post.id, change: c, by: profile || "", at: new Date().toISOString().slice(0, 10) }] });
    setChange("");
  };
  return (
    <div className="in-marker">
      <FlaskConical size={14} />
      {tests.length ? <span>Testing: {tests.map((t) => <b key={t.id}>{t.change}</b>)}</span> : <span className="ig-dim">Was this post a test of something?</span>}
      <input list="in-presets" value={change} onChange={(e) => setChange(e.target.value)} placeholder="e.g. A question in the first line" onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
      <datalist id="in-presets">{EXPERIMENT_PRESETS.map((p) => <option key={p} value={p} />)}</datalist>
      <button className="btn" onClick={add}>Mark as a test</button>
    </div>
  );
}

export function Tests({ media, data, saveData, profile, onSelect }) {
  const { tests, learned } = useMemo(() => experimentResults(data?.igExperiments || [], media), [data, media]);
  const recent = useMemo(() => media.filter((m) => kindOf(m) !== "STORY" && Date.now() - Date.parse(m.posted_at) < 21 * 86400000), [media]);
  const [pick, setPick] = useState("");
  const [change, setChange] = useState("");
  const add = () => {
    if (!pick || !change.trim()) return;
    saveData({ ...data, igExperiments: [...(data.igExperiments || []), { id: uid(), mediaId: pick, change: change.trim(), by: profile || "", at: new Date().toISOString().slice(0, 10) }] });
    setPick(""); setChange("");
  };
  const remove = (id) => saveData({ ...data, igExperiments: (data.igExperiments || []).filter((e) => e.id !== id) });
  const COLOR = { better: "var(--good)", worse: "var(--alert)" };
  return (
    <>
      <section className="ig-card">
        <h3>What we've learned</h3>
        <p className="ig-dim ig-review-sub">
          Change one thing on a post, mark it as a test, and after three days its reach is read against your usual for that kind
          of post. Two or more tests of the same change make a finding; one test is a hint.
        </p>
        {learned.length ? (
          <ul className="in-learned">
            {learned.map((l) => (
              <li key={l.change}>
                <span className="in-hook-rel" style={{ color: relColor(l.rel) }}>{x2(l.rel)}</span>
                <span><strong>{l.change}</strong> — {l.word} <span className="ig-dim">({l.n} test{l.n === 1 ? "" : "s"})</span></span>
              </li>
            ))}
          </ul>
        ) : <div className="ig-empty-chart">No finished tests yet.</div>}
      </section>
      <section className="ig-card">
        <h3>Start a test</h3>
        <div className="in-edit">
          <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ flex: 2 }}>
            <option value="">Which recent post?</option>
            {recent.map((m) => <option key={m.id} value={m.id}>{new Date(m.posted_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })} — {firstLine(m).slice(0, 60)}</option>)}
          </select>
          <input list="in-presets-2" value={change} onChange={(e) => setChange(e.target.value)} placeholder="What did you change?" style={{ flex: 2 }} />
          <datalist id="in-presets-2">{EXPERIMENT_PRESETS.map((p) => <option key={p} value={p} />)}</datalist>
          <button className="btn btn-gold" onClick={add}><FlaskConical size={13} /> Start</button>
        </div>
        <p className="ig-dim" style={{ margin: "8px 0 0" }}>You can also mark a post as a test from its review.</p>
      </section>
      {tests.length ? (
        <section className="ig-card">
          <h3>Every test</h3>
          <ul className="in-learned">
            {tests.map((t) => (
              <li key={t.id}>
                <span className="in-hook-rel" style={{ color: COLOR[t.verdict] || "var(--muted)" }}>{t.status === "done" ? x2(t.rel) : t.status === "waiting" ? "…" : "?"}</span>
                <span className={t.post ? "ig-row-click" : ""} onClick={() => t.post && onSelect(t.post)}>
                  <strong>{t.change}</strong> — {t.status === "done" ? t.verdict : t.status === "waiting" ? "waiting for the numbers to settle" : "post not found"}
                  {t.post ? <span className="ig-dim"> · {firstLine(t.post).slice(0, 50)}</span> : null}
                  <span className="ig-dim"> · {t.by || "someone"}, {t.at}</span>
                </span>
                <button className="icon-btn" onClick={() => remove(t.id)} aria-label="Remove"><X size={12} /></button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/* ----------------------------------- Brief ---------------------------------- */

export function Brief({ media, data, saveData, account, profile }) {
  const briefs = data?.igBriefs || [];
  const brief = briefs[0] || null;
  const insights = data?.igCommentInsights || null;
  const [made, setMade] = useState({});
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");
  const stale = !brief || Date.now() - Date.parse(brief.at) > 28 * 86400000;

  const write = () => {
    const next = buildBrief({ media, themes: data?.igThemes, content: data?.content || [], experiments: data?.igExperiments || [], comments: insights, accountDays: account });
    saveData({ ...data, igBriefs: [{ ...next, by: profile || "" }, ...briefs].slice(0, 6) });
  };
  const makeDuty = (key, title, description) => {
    const task = {
      id: uid(), title: title.slice(0, 120), description, assignee: profile || "", status: "todo", priority: "medium", type: "film",
      dueDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), steps: [], notes: [], link: "",
    };
    saveData({ ...data, tasks: [task, ...(data.tasks || [])] });
    setMade({ ...made, [key]: true });
  };
  const readComments = async () => {
    setLoading(true);
    setNote("");
    try {
      const res = await fetch("/api/instagram-status?comments=1");
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `Couldn't read comments (${res.status}).`);
      if (out.needsPermission) setNote("permission");
      else if (out.note) setNote(out.note);
      else saveData({ ...data, igCommentInsights: commentInsights(out.threads || []) });
    } catch (err) {
      setNote(err.message);
    }
    setLoading(false);
  };
  const Line = ({ item }) => (
    <li><strong>{item.text}</strong> <span className="ig-dim">— {item.why}</span></li>
  );

  return (
    <>
      <section className="ig-card">
        <div className="ig-card-head">
          <h3>{brief ? `The brief — ${shortDate(brief.at)}` : "This month's brief"}</h3>
          <button className={`btn ${stale ? "btn-gold" : "btn-ghost"}`} onClick={write}><RefreshCw size={13} /> {brief ? "Write a new one" : "Write it"}</button>
        </div>
        {!brief ? (
          <p className="ig-dim" style={{ margin: 0 }}>
            One page from everything Analytics knows: what to keep doing, what to change, one thing to test, when to post, and post ideas —
            each with the numbers behind it. Saved for the whole team; write a new one each month.
          </p>
        ) : (
          <>
            {stale ? <div className="ig-note">This brief is over four weeks old — write a new one to use the latest numbers.</div> : null}
            <div className="ig-review-verdicts">
              <section className="ig-verdict ig-verdict-good">
                <h4><ArrowUpRight size={15} /> Keep doing</h4>
                {brief.keep.length ? <ul>{brief.keep.map((i) => <Line key={i.text} item={i} />)}</ul> : <p className="ig-dim">Nothing stands out yet.</p>}
              </section>
              <section className="ig-verdict ig-verdict-weak">
                <h4><ArrowDownRight size={15} /> Change</h4>
                {brief.change.length ? <ul>{brief.change.map((i) => <Line key={i.text} item={i} />)}</ul> : <p className="ig-dim">Nothing clearly underperforming.</p>}
              </section>
            </div>
            <div className="in-facts" style={{ marginBottom: 12 }}>
              {brief.when.length ? <span><b>When to post:</b> {brief.when.map((w) => `${w.text} (${w.why.split(" ")[0]})`).join(" · ")}</span> : null}
              {brief.test ? <span><b>Test this month:</b> {brief.test.text}</span> : null}
              <span className="ig-dim">{brief.context.posts4w} posts in the four weeks before it was written</span>
            </div>
            {brief.ideas.length ? (
              <>
                <h4 className="in-h4">Post ideas</h4>
                <ul className="in-ideas">
                  {brief.ideas.map((idea, i) => (
                    <li key={idea.title}>
                      <div>
                        <strong>{idea.title}</strong>
                        <div className="ig-dim">{idea.detail} {idea.permalink ? <a href={idea.permalink} target="_blank" rel="noreferrer">See the original</a> : null}</div>
                      </div>
                      {made[i] ? <span className="ig-dim"><Check size={13} /> On your duties</span>
                        : <button className="btn" onClick={() => makeDuty(i, idea.title, `${idea.detail}\n\nFrom the Analytics brief of ${brief.at}.`)}><ListChecks size={13} /> Make it a duty</button>}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        )}
      </section>

      <section className="ig-card">
        <div className="ig-card-head">
          <h3>What people say in the comments</h3>
          <button className="btn btn-ghost" onClick={readComments} disabled={loading}><MessageSquare size={13} className={loading ? "ig-spin" : ""} /> {insights ? "Read again" : "Read the comments"}</button>
        </div>
        {note === "permission" ? (
          <div className="ig-note ig-note-bad">
            <AlertTriangle size={14} /> Instagram hasn't allowed this connection to read comments yet. Reconnect once to grant it:{" "}
            <a href={`/api/instagram-connect?profile=${encodeURIComponent(profile || "")}`}>Reconnect Instagram</a>
          </div>
        ) : note ? <div className="ig-note">{note}</div> : null}
        {insights ? (
          <>
            <p className="ig-dim ig-review-sub">{insights.total} comments on your last 20 posts, read {shortDate(insights.at)}. {Math.round(insights.emojiShare * 100)}% are emoji only.</p>
            {insights.questions.length ? (
              <>
                <h4 className="in-h4">Questions people asked — each one is a post idea</h4>
                <ul className="in-ideas">
                  {insights.questions.map((q, i) => (
                    <li key={q.text}>
                      <div>“{q.text}”{q.likes ? <span className="ig-dim"> · {q.likes} likes</span> : null}</div>
                      {made[`q${i}`] ? <span className="ig-dim"><Check size={13} /> On your duties</span>
                        : <button className="btn" onClick={() => makeDuty(`q${i}`, `Answer: ${q.text.slice(0, 80)}`, `Someone asked this in the comments:\n“${q.text}”\n\nA post that answers it gives everyone who wondered a reason to watch.`)}><ListChecks size={13} /> Make it a duty</button>}
                    </li>
                  ))}
                </ul>
              </>
            ) : <p className="ig-dim">No questions in recent comments.</p>}
            {insights.words.length ? (
              <div className="in-suggest" style={{ marginTop: 10 }}>
                <span className="ig-dim">What they keep mentioning:</span>
                {insights.words.map(([w, n]) => <span key={w} className="bm-chip">{w} <span className="ig-dim">{n}</span></span>)}
              </div>
            ) : null}
          </>
        ) : !note ? <p className="ig-dim" style={{ margin: 0 }}>Reads the latest comments on your last 20 posts and pulls out the questions people ask and what they keep mentioning.</p> : null}
      </section>
    </>
  );
}

/* ----------------------------------- Team ----------------------------------- */

export function Team({ media, data, onSelect }) {
  const people = useMemo(() => peopleStats(data?.content || [], media, data?.tasks || []), [data, media]);
  return (
    <section className="ig-card">
      <h3>The team</h3>
      <p className="ig-dim ig-review-sub">
        Who made what, and how it did once posted — from uploads in Content Review that were linked to their Instagram post.
        Only leads see this page. It's for giving people the work that suits them, and noticing who's improving.
      </p>
      {people.length ? (
        <div className="ig-table-scroll">
          <table className="ig-table">
            <thead><tr><th>Person</th><th className="num">Uploads</th><th className="num">Posted &amp; linked</th><th className="num">Reach vs usual</th><th className="num">Saves /100</th><th className="num">Watched through</th><th className="num">Duties done (30 d)</th><th className="num">Trend</th><th>Best</th></tr></thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.name}>
                  <td><strong>{p.name}</strong></td>
                  <td className="num">{p.uploads}</td>
                  <td className="num">{p.posts.length}</td>
                  <td className="num" style={{ color: relColor(p.rel) }}>{p.posts.length ? x2(p.rel) : "—"}</td>
                  <td className="num">{n2(p.saves)}</td>
                  <td className="num">{p.completion == null ? "—" : `${Math.round(p.completion * 100)}%`}</td>
                  <td className="num">{p.dutiesDone}</td>
                  <td className="num" style={{ color: p.trend == null ? "var(--muted)" : p.trend >= 1.2 ? "var(--good)" : p.trend <= 0.8 ? "var(--alert)" : "var(--text)" }}>{p.trend == null ? "—" : p.trend >= 1.2 ? "improving" : p.trend <= 0.8 ? "dipping" : "steady"}</td>
                  <td>{p.best ? <button className="btn btn-ghost" onClick={() => onSelect(p.best.post)}>{firstLine(p.best.post).slice(0, 28)} ({x2(p.best.rel)})</button> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="ig-empty-chart">Nobody's uploads are linked to Instagram posts yet. Link them in Content Review → Published.</div>}
    </section>
  );
}

// On a post's review: which themes it belongs to, tap to add or take away.
export function ThemeChips({ post, data, saveData }) {
  const themes = data?.igThemes;
  if (!themes?.list?.length || !saveData) return null;
  const on = new Set(themesOf(post, themes));
  const toggle = (t) => {
    const manual = { ...(themes.manual || {}) };
    const off = { ...(themes.off || {}) };
    const m = new Set(manual[post.id] || []);
    const o = new Set(off[post.id] || []);
    if (on.has(t.id)) { m.delete(t.id); o.add(t.id); } else { o.delete(t.id); m.add(t.id); }
    manual[post.id] = [...m];
    off[post.id] = [...o];
    saveData({ ...data, igThemes: { ...themes, manual, off } });
  };
  return (
    <div className="in-suggest" style={{ margin: "0 0 14px" }}>
      <span className="ig-dim">Themes:</span>
      {themes.list.map((t) => (
        <button key={t.id} className={`bm-chip${on.has(t.id) ? " on" : ""}`} onClick={() => toggle(t)}>{on.has(t.id) ? <Check size={11} /> : <Plus size={11} />} {t.name}</button>
      ))}
    </div>
  );
}


/* ------------------------------ in the Calendar ------------------------------ */
// The calendar lives in App.jsx; these two pieces bring the Instagram history
// to it: a forecast in the event form, and a warning about gaps in the plan.

let accountCache = null;
function loadAccountDays() {
  if (!accountCache) {
    const since = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
    accountCache = supabase.from("ig_account_snapshots").select("day, reach, new_followers").gte("day", since).order("day")
      .then(({ data, error }) => (error ? [] : data || [])).catch(() => []);
  }
  return accountCache;
}
function useHistory() {
  const [state, setState] = useState({ media: null, days: null });
  useEffect(() => {
    let live = true;
    Promise.all([loadMedia(), loadAccountDays()]).then(([media, days]) => { if (live) setState({ media, days }); });
    return () => { live = false; };
  }, []);
  return state;
}

const POST_TYPES = { post: "REELS", photo: "FEED", graphic: "FEED" };

export function ReachForecast({ type, date, time }) {
  const { media } = useHistory();
  const times = useMemo(() => (media && media.length ? postingTimes(media) : null), [media]);
  if (!POST_TYPES[type] || !times || !date) return null;
  const p = predictReach(media, times, { kind: POST_TYPES[type], when: `${date}T${time || "09:00"}:00` });
  if (!p) return null;
  const noun = POST_TYPES[type] === "REELS" ? "reel" : "post";
  return (
    <div className="in-forecast">
      Likely reach: <b>about {Math.round(p.expected / 50) * 50}</b>
      <span className="ig-dim">
        {" "}— your typical {noun} lately reaches {Math.round(p.typical)}
        {p.slotKnown ? `, and ${p.slot} usually gets ${p.factor.toFixed(2)}× that` : `; there aren't enough posts at ${p.slot} to say how that time does`}.
      </span>
    </div>
  );
}

const dayIso = (d) => new Date(d).toISOString().slice(0, 10);
const nice = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

export function CalendarHints({ events }) {
  const { media, days } = useHistory();
  const effect = useMemo(() => (media && days ? quietEffect(media, days) : null), [media, days]);
  if (!media) return null;
  const today = dayIso(Date.now());
  const horizon = dayIso(Date.now() + 14 * 86400000);
  const lastPosted = media.filter((m) => kindOf(m) !== "STORY").map((m) => m.posted_at.slice(0, 10)).filter((d) => d <= today).sort().pop();
  const planned = (events || [])
    .filter((e) => POST_TYPES[e.type] && e.status !== "skipped" && e.date >= today && e.date <= horizon)
    .map((e) => e.date);
  const marks = [...new Set([lastPosted || today, ...planned, horizon])].sort();
  let gap = null;
  for (let i = 1; i < marks.length; i++) {
    const length = (Date.parse(marks[i]) - Date.parse(marks[i - 1])) / 86400000;
    if (length >= 4 && marks[i] > today) {
      const from = dayIso(Math.max(Date.parse(marks[i - 1]) + 86400000, Date.parse(today)));
      gap = { from, to: marks[i] === horizon ? null : dayIso(Date.parse(marks[i]) - 86400000), days: Math.round((Date.parse(marks[i]) - Date.parse(from)) / 86400000) };
      break;
    }
  }
  if (!gap || gap.days < 3) return null;
  return (
    <div className="ig-note in-gap">
      <AlertTriangle size={14} />
      <span>
        {gap.to ? <>Nothing planned to post from <b>{nice(gap.from)}</b> to <b>{nice(gap.to)}</b> ({gap.days} days).</> : <>Nothing planned to post after <b>{nice(gap.from)}</b> for the next two weeks.</>}
        {effect && effect.ratio < 0.9 ? <> Lately, days 4–10 after a post reached about {Math.round(effect.quiet).toLocaleString()} accounts, against {Math.round(effect.active).toLocaleString()} on the day of or after posting.</> : null}
      </span>
    </div>
  );
}
