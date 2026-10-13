// Benchmarks: a few accounts the team measures itself against, side by side
// with its own. Only public numbers exist for other accounts — followers, and
// likes and comments on recent posts — so the comparison sticks to those, for
// both sides, rather than setting their likes against our reach.
import React, { useEffect, useMemo, useState } from "react";
import { Plus, X, ExternalLink, AlertTriangle, RefreshCw } from "lucide-react";

const median = (values) => {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};
const full = (n) => (n == null ? "—" : Math.round(n).toLocaleString());
const pct = (n, d = 1) => (n == null ? "—" : `${n.toFixed(d)}%`);
const DAY = 86400000;
const USERNAME = /^[A-Za-z0-9._]{1,30}$/;

// The same handful of measures for any account, from what Business Discovery gives.
function measure(acct, history) {
  if (!acct || !acct.ok) return null;
  const posts = acct.posts || [];
  const now = Date.now();
  const last28 = posts.filter((p) => now - Date.parse(p.at) <= 28 * DAY);
  // Fewer posts back than the 30 asked for and none older than 28 days means
  // the list itself ran out; otherwise the window is fully covered.
  const perWeek = last28.length / 4;
  const likes = median(posts.map((p) => p.likes));
  const comments = median(posts.map((p) => p.comments));
  const engagement = acct.followers && (likes != null || comments != null)
    ? (((likes || 0) + (comments || 0)) / acct.followers) * 100 : null;
  const reels = posts.length ? posts.filter((p) => p.type === "reel").length / posts.length : null;
  const h = (history || []).filter((x) => now - Date.parse(x[0]) <= 31 * DAY);
  const growth = h.length >= 2 ? h[h.length - 1][1] - h[0][1] : null;
  const growthDays = h.length >= 2 ? Math.round((Date.parse(h[h.length - 1][0]) - Date.parse(h[0][0])) / DAY) : null;
  const scored = posts
    .filter((p) => p.likes != null || p.comments != null)
    .map((p) => ({ ...p, score: acct.followers ? (((p.likes || 0) + (p.comments || 0)) / acct.followers) * 100 : 0 }))
    .sort((a, b) => b.score - a.score);
  return {
    username: acct.username, name: acct.name, picture: acct.picture, followers: acct.followers,
    perWeek, likes, comments, engagement, reels, growth, growthDays,
    likesHidden: posts.length > 0 && posts.every((p) => p.likes == null),
    best: scored.slice(0, 3),
  };
}

// Plain-language differences that are big enough to matter (1.5x and up).
function observations(own, others) {
  const out = [];
  if (!own) return out;
  for (const o of others) {
    if (o.perWeek && own.perWeek != null && o.perWeek >= Math.max(1, own.perWeek * 1.5)) {
      out.push(`@${o.username} posts about ${o.perWeek.toFixed(1)} times a week — ${own.perWeek ? `${(o.perWeek / own.perWeek).toFixed(1)}× as often as you (${own.perWeek.toFixed(1)})` : "you posted nothing in the last four weeks"}.`);
    }
    if (o.engagement && own.engagement && o.engagement >= own.engagement * 1.5) {
      out.push(`@${o.username}'s posts draw ${(o.engagement / own.engagement).toFixed(1)}× your likes and comments per follower (${pct(o.engagement, 2)} vs ${pct(own.engagement, 2)}). Their best posts below show what earns it.`);
    }
    if (o.reels != null && own.reels != null && o.reels - own.reels >= 0.3) {
      out.push(`Reels are ${Math.round(o.reels * 100)}% of @${o.username}'s recent posts, against ${Math.round(own.reels * 100)}% of yours.`);
    }
    if (own.engagement && o.engagement && own.engagement >= o.engagement * 1.5) {
      out.push(`You out-engage @${o.username}: ${(own.engagement / o.engagement).toFixed(1)}× their likes and comments per follower.`);
    }
  }
  return out.slice(0, 6);
}

export default function Benchmarks({ data, saveData }) {
  const names = (data && data.igBenchmarks) || [];
  const history = (data && data.igBenchmarkHistory) || {};
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState("");
  const [state, setState] = useState({ loading: false, own: null, accounts: [], error: "" });
  const [reload, setReload] = useState(0);
  const key = names.join(",");

  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: "" }));
    fetch(`/api/instagram-status?benchmarks=${encodeURIComponent(key)}`)
      .then(async (r) => {
        const out = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(out.error || `Couldn't load benchmarks (${r.status}).`);
        return out;
      })
      .then((out) => { if (live) setState({ loading: false, own: out.own || null, accounts: out.accounts || [], error: out.note || "" }); })
      .catch((err) => { if (live) setState({ loading: false, own: null, accounts: [], error: err.message }); });
    return () => { live = false; };
  }, [key, reload]);

  const add = () => {
    const u = draft.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/\/.*$/, "");
    if (!USERNAME.test(u)) { setDraftError("That doesn't look like an Instagram username."); return; }
    if (names.some((n) => n.toLowerCase() === u.toLowerCase())) { setDraftError("Already on the list."); return; }
    if (names.length >= 8) { setDraftError("Eight is the most — remove one first."); return; }
    saveData({ ...data, igBenchmarks: [...names, u] });
    setDraft("");
    setDraftError("");
  };
  const remove = (u) => saveData({ ...data, igBenchmarks: names.filter((n) => n !== u) });

  const own = useMemo(() => measure(state.own, state.own && history[state.own.username?.toLowerCase()]), [state.own, history]);
  const others = useMemo(() => state.accounts.map((a) => ({ raw: a, m: measure(a, history[a.username?.toLowerCase()]) })), [state.accounts, history]);
  const measured = others.map((o) => o.m).filter(Boolean);
  const notes = observations(own, measured);
  const bestPosts = measured.flatMap((m) => m.best.map((p) => ({ ...p, username: m.username }))).sort((a, b) => b.score - a.score).slice(0, 8);

  const rows = [own && { ...own, mine: true }, ...measured].filter(Boolean);
  return (
    <div>
      <section className="ig-card">
        <h3>Accounts to compare with</h3>
        <p className="ig-dim ig-review-sub">
          Add up to eight Instagram accounts you'd like to measure yourselves against — similar schools, churches, or anyone whose content you admire.
          They need to be Business or Creator accounts; personal ones can't be looked up. Only their public numbers are visible, so everything
          here compares likes, comments and followers — the same for you and for them.
        </p>
        <div className="bm-add">
          <input value={draft} onChange={(e) => { setDraft(e.target.value); setDraftError(""); }} onKeyDown={(e) => { if (e.key === "Enter") add(); }} placeholder="@username" />
          <button className="btn btn-gold" onClick={add}><Plus size={14} /> Add</button>
          <button className="btn btn-ghost" onClick={() => setReload((n) => n + 1)} disabled={state.loading}><RefreshCw size={13} className={state.loading ? "ig-spin" : ""} /> Refresh</button>
        </div>
        {draftError ? <div className="ig-note ig-note-bad" style={{ marginTop: 8 }}><AlertTriangle size={14} /> {draftError}</div> : null}
        {names.length ? (
          <div className="bm-chips">
            {names.map((u) => {
              const failed = state.accounts.find((a) => a.username?.toLowerCase() === u.toLowerCase() && !a.ok);
              return (
                <span key={u} className={`bm-chip${failed ? " bad" : ""}`} title={failed ? failed.error : undefined}>
                  @{u}{failed ? " — not found" : ""}
                  <button onClick={() => remove(u)} aria-label={`Remove ${u}`}><X size={12} /></button>
                </span>
              );
            })}
          </div>
        ) : null}
        {state.error ? <div className="ig-note" style={{ marginTop: 10 }}>{state.error}</div> : null}
        {others.filter((o) => !o.raw.ok).map((o) => (
          <div key={o.raw.username} className="ig-note ig-note-bad" style={{ marginTop: 8 }}><AlertTriangle size={14} /> @{o.raw.username}: {o.raw.error}</div>
        ))}
      </section>

      {state.loading && !rows.length ? <div className="ig-empty-chart">Looking them up…</div> : null}

      {rows.length ? (
        <section className="ig-card">
          <h3>Side by side</h3>
          <p className="ig-dim ig-review-sub">From each account's last 30 posts. Growth appears once the nightly sync has recorded their followers for a few days.</p>
          <div className="ig-table-scroll">
            <table className="ig-table">
              <thead>
                <tr>
                  <th>Account</th><th className="num">Followers</th><th className="num">Growth</th><th className="num">Posts / week</th>
                  <th className="num">Reels</th><th className="num">Likes / post</th><th className="num">Comments / post</th><th className="num">Engagement / follower</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.username} className={r.mine ? "bm-mine" : ""}>
                    <td className="ig-post-cell">
                      {r.picture ? <img src={r.picture} alt="" style={{ borderRadius: "50%", width: 28, height: 28 }} /> : <span className="ig-thumb-blank" style={{ borderRadius: "50%", width: 28, height: 28 }} />}
                      <span className="ig-post-caption">@{r.username}{r.mine ? " (you)" : ""}</span>
                    </td>
                    <td className="num">{full(r.followers)}</td>
                    <td className="num">{r.growth == null ? "—" : `${r.growth >= 0 ? "+" : "−"}${full(Math.abs(r.growth))} in ${r.growthDays} d`}</td>
                    <td className="num">{r.perWeek.toFixed(1)}</td>
                    <td className="num">{r.reels == null ? "—" : `${Math.round(r.reels * 100)}%`}</td>
                    <td className="num">{r.likesHidden ? "hidden" : full(r.likes)}</td>
                    <td className="num">{full(r.comments)}</td>
                    <td className="num">{pct(r.engagement, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {notes.length ? <ul className="ig-advice" style={{ marginTop: 14 }}>{notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
        </section>
      ) : null}

      {bestPosts.length ? (
        <section className="ig-card">
          <h3>Their best recent posts</h3>
          <p className="ig-dim ig-review-sub">Ranked by likes and comments for the size of the account, so a small account's hit counts as much as a big one's.</p>
          <div className="ig-best-row">
            {bestPosts.map((p) => (
              <a key={p.id} className="ig-best" href={p.permalink} target="_blank" rel="noreferrer">
                {p.thumb ? <img src={p.thumb} alt="" loading="lazy" /> : <span className="ig-thumb-blank" />}
                <span className="ig-best-num">@{p.username}</span>
                <span className="ig-dim">{full(p.likes)} likes · {full(p.comments)} comments · {p.type}</span>
                <span className="ig-dim bm-caption">{p.caption || "(no caption)"}</span>
                <span className="ig-dim"><ExternalLink size={11} /> Open</span>
              </a>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
