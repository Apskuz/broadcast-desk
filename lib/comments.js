// Recent comments on the team's own posts, for Analytics → Brief. Read live
// rather than stored: they're only needed when someone asks for the summary.
//   GET /api/instagram-status?comments=1
// Needs the instagram_manage_comments permission; a connection made before it
// was requested gets a clear "reconnect" answer instead of an error.
import { createClient } from "@supabase/supabase-js";
import { GRAPH_VERSION } from "../api/instagram-connect.js";

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const POSTS = 20;
const PER_POST = 50;

async function graph(path, params) {
  const res = await fetch(`${GRAPH}/${path}?${new URLSearchParams(params)}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = new Error(json.error?.message || `Instagram API returned ${res.status}`);
    e.code = json.error?.code;
    throw e;
  }
  return json;
}

export async function commentsHandler(req, res) {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return res.status(500).json({ error: "Server is missing SUPABASE_SERVICE_ROLE_KEY." });
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { data: accounts } = await supabase.from("ig_accounts").select("ig_user_id, access_token").limit(1);
  const account = accounts && accounts[0];
  if (!account) return res.status(200).json({ threads: [], note: "Connect Instagram first." });
  const { data: media } = await supabase.from("ig_media")
    .select("id, caption, posted_at, media_product_type")
    .eq("ig_user_id", account.ig_user_id).neq("media_product_type", "STORY")
    .order("posted_at", { ascending: false }).limit(POSTS);

  const threads = [];
  let denied = false;
  for (const m of media || []) {
    try {
      const json = await graph(`${m.id}/comments`, { fields: "text,timestamp,like_count", limit: String(PER_POST), access_token: account.access_token });
      threads.push({
        mediaId: m.id,
        caption: (m.caption || "").slice(0, 120),
        comments: (json.data || []).map((c) => ({ text: (c.text || "").slice(0, 400), at: c.timestamp, likes: c.like_count || 0 })),
      });
    } catch (err) {
      // 10 / 200: the permission isn't on this connection.
      if (err.code === 10 || err.code === 200 || /permission/i.test(err.message)) { denied = true; break; }
    }
  }
  if (denied) return res.status(200).json({ threads: [], needsPermission: true });
  res.setHeader("Cache-Control", "private, max-age=600");
  return res.status(200).json({ threads });
}
