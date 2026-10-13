// How a published piece did on Instagram, shown on its card in Content
// Review. The piece and the Instagram post are linked once — the app suggests
// the likeliest match from the caption, or anyone can pick it — and from then
// on the card shows the post's numbers next to the account's usual.
import React, { useEffect, useMemo, useState } from "react";
import { ExternalLink, Link2, X, BarChart3 } from "lucide-react";
import { supabase } from "./supabaseClient";
import { relativeReach, matchScore, ageDays, kindOf } from "./igInsights";

// One load for every card on the page, refreshed at most every five minutes.
let cache = null;
let cachedAt = 0;
function loadMedia() {
  if (!cache || Date.now() - cachedAt > 300000) {
    cachedAt = Date.now();
    cache = supabase.from("ig_media_latest").select("*").order("posted_at", { ascending: false }).range(0, 1999)
      .then(({ data, error }) => (error ? [] : data || []))
      .catch(() => []);
  }
  return cache;
}

function useIgMedia() {
  const [media, setMedia] = useState(null);
  useEffect(() => {
    let live = true;
    loadMedia().then((m) => { if (live) setMedia(m); });
    return () => { live = false; };
  }, []);
  return media;
}

const n = (v) => (v == null ? "—" : Math.round(v).toLocaleString());
const thumb = (m) => m.thumbnail_url || m.media_url;

export default function IgPostLink({ item, linkedIds, onLink, onOpen }) {
  const media = useIgMedia();
  const [picking, setPicking] = useState(false);

  const post = media && item.igMediaId ? media.find((m) => m.id === item.igMediaId) : null;
  const rel = useMemo(() => (post && media ? relativeReach(post, media) : null), [post, media]);
  const candidates = useMemo(() => {
    if (!media || item.igMediaId) return [];
    return media
      .filter((m) => kindOf(m) !== "STORY" && ageDays(m) < 180 && !linkedIds.has(m.id))
      .map((m) => ({ m, score: matchScore(item, m) }))
      .sort((a, b) => b.score - a.score);
  }, [media, item, linkedIds]);

  if (!media) return null;
  if (!media.length) return null; // Instagram isn't connected; nothing to show

  if (post) {
    const relColor = rel == null ? "var(--muted)" : rel >= 1.4 ? "var(--good)" : rel <= 0.7 ? "var(--alert)" : "var(--text)";
    return (
      <div className="igl">
        <div className="igl-head">
          {thumb(post) ? <img src={thumb(post)} alt="" loading="lazy" /> : null}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="igl-title">On Instagram since {new Date(post.posted_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</div>
            {rel != null ? (
              <div style={{ color: relColor, fontSize: 12.5, fontWeight: 600 }}>
                {rel.toFixed(1)}× the reach of a typical {kindOf(post) === "REELS" ? "reel" : "post"} from around then
              </div>
            ) : <div className="igl-dim">{post.reach == null ? "Numbers arrive with tonight's sync." : "Not enough comparable posts yet."}</div>}
          </div>
        </div>
        {post.reach != null ? (
          <div className="igl-stats">
            <span><b>{n(post.views)}</b> views</span>
            <span><b>{n(post.reach)}</b> reached</span>
            <span><b>{n(post.likes)}</b> likes</span>
            <span><b>{n(post.comments)}</b> comments</span>
            <span><b>{n(post.saved)}</b> saves</span>
            <span><b>{n(post.shares)}</b> shares</span>
            {post.avg_watch_time_ms ? <span><b>{(post.avg_watch_time_ms / 1000).toFixed(1)} s</b> avg watch</span> : null}
          </div>
        ) : null}
        <div className="igl-actions">
          <button className="btn" onClick={() => onOpen(post.id)}><BarChart3 size={13} /> Full analytics</button>
          {post.permalink ? <a className="btn" href={post.permalink} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Instagram</a> : null}
          <button className="btn btn-ghost" onClick={() => onLink(null)}>Wrong post?</button>
        </div>
      </div>
    );
  }

  const best = candidates[0];
  const confident = best && best.score >= 0.5;
  return (
    <div className="igl">
      {confident && !picking ? (
        <div className="igl-suggest">
          {thumb(best.m) ? <img src={thumb(best.m)} alt="" loading="lazy" /> : null}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="igl-title">Is this the Instagram post?</div>
            <div className="igl-dim igl-clip">{(best.m.caption || "(no caption)").replace(/\s+/g, " ")}</div>
          </div>
          <button className="btn btn-gold" onClick={() => onLink(best.m.id)}><Link2 size={13} /> Yes, link it</button>
        </div>
      ) : null}
      {picking ? (
        <>
          <div className="igl-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            Which post is it?
            <button className="icon-btn" onClick={() => setPicking(false)} aria-label="Close"><X size={14} /></button>
          </div>
          <div className="igl-grid">
            {candidates.slice(0, 18).map(({ m }) => (
              <button key={m.id} onClick={() => { onLink(m.id); setPicking(false); }} title={(m.caption || "").slice(0, 120)}>
                {thumb(m) ? <img src={thumb(m)} alt="" loading="lazy" /> : <span className="igl-blank" />}
                <span>{new Date(m.posted_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <button className="btn btn-ghost" style={{ marginTop: confident ? 6 : 0 }} onClick={() => setPicking(true)}>
          <Link2 size={13} /> {confident ? "No — pick another" : "Link the Instagram post to see how it did"}
        </button>
      )}
    </div>
  );
}
