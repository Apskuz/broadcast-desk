// Other Instagram accounts' public numbers, through Meta's Business Discovery:
// our own connected account asks about theirs. Only works for Business and
// Creator accounts, and only gives what anyone can see on the profile —
// followers, and likes and comments on recent posts; never their reach,
// views or watch time.
import { createClient } from "@supabase/supabase-js";
import { GRAPH_VERSION } from "../api/instagram-connect.js";

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
export const USERNAME = /^[A-Za-z0-9._]{1,30}$/;

async function graph(path, params) {
  const res = await fetch(`${GRAPH}/${path}?${new URLSearchParams(params)}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error?.error_user_msg || json.error?.message || `Instagram API returned ${res.status}`);
  return json;
}

const MEDIA_FULL = "id,caption,like_count,comments_count,timestamp,media_type,media_product_type,permalink,media_url,thumbnail_url";
const MEDIA_BASIC = "id,caption,like_count,comments_count,timestamp,media_type,permalink,media_url";

export async function discover(account, username, { posts = 30 } = {}) {
  const ask = (mediaFields) => graph(account.ig_user_id, {
    fields: `business_discovery.username(${username}){username,name,profile_picture_url,followers_count,media_count${posts ? `,media.limit(${posts}){${mediaFields}}` : ""}}`,
    access_token: account.access_token,
  });
  let json;
  try {
    json = await ask(MEDIA_FULL);
  } catch (err) {
    // Some media fields are refused for some accounts; the basic set still says plenty.
    if (!posts) throw err;
    json = await ask(MEDIA_BASIC);
  }
  const bd = json.business_discovery || {};
  return {
    username: bd.username || username,
    name: bd.name || null,
    picture: bd.profile_picture_url || null,
    followers: bd.followers_count ?? null,
    mediaCount: bd.media_count ?? null,
    posts: (bd.media?.data || []).map((m) => ({
      id: m.id,
      caption: (m.caption || "").slice(0, 300),
      likes: m.like_count ?? null, // null when the account hides like counts
      comments: m.comments_count ?? null,
      at: m.timestamp,
      type: m.media_product_type === "REELS" ? "reel" : m.media_type === "CAROUSEL_ALBUM" ? "carousel" : m.media_type === "VIDEO" ? "video" : "photo",
      permalink: m.permalink,
      thumb: m.thumbnail_url || (m.media_type === "VIDEO" ? null : m.media_url) || null,
    })),
  };
}

/* ------------------------------- the endpoint ------------------------------ */

// Per warm instance; the numbers barely move within half an hour, and Meta
// counts every call against the hourly limit.
const cache = new Map();
const FRESH_MS = 30 * 60000;

function db() {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Server is missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  return createClient(url, key, { auth: { persistSession: false } });
}

// GET /api/instagram-status?benchmarks=a,b,c — routed from instagram-status.js,
// because the Hobby plan caps a deployment at 12 functions.
export async function benchmarksHandler(req, res) {
  const names = String(req.query?.benchmarks || "")
    .split(",").map((u) => u.trim().replace(/^@/, "")).filter(Boolean).slice(0, 8);
  const bad = names.find((u) => !USERNAME.test(u));
  if (bad) return res.status(400).json({ error: `"${bad}" isn't an Instagram username.` });

  let supabase;
  try { supabase = db(); } catch (e) { return res.status(500).json({ error: e.message }); }
  const { data: accounts, error } = await supabase.from("ig_accounts").select("ig_user_id, username, access_token").limit(1);
  if (error) return res.status(500).json({ error: error.message });
  const account = accounts && accounts[0];
  if (!account) return res.status(200).json({ accounts: [], note: "Connect Instagram first." });

  const results = await Promise.all([account.username, ...names].map(async (username) => {
    if (!username) return null;
    const key = username.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < FRESH_MS) return hit.value;
    try {
      const value = { ok: true, ...(await discover(account, username)) };
      cache.set(key, { at: Date.now(), value });
      return value;
    } catch (err) {
      // Most often: a personal account (not discoverable) or a typo.
      return { ok: false, username, error: /business|not be found|does not exist|Invalid user/i.test(err.message) ? "Not found, or not a Business/Creator account (personal accounts can't be looked up)." : err.message };
    }
  }));
  res.setHeader("Cache-Control", "private, max-age=300");
  return res.status(200).json({ own: results[0], accounts: results.slice(1) });
}
