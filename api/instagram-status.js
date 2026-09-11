// The Analytics screen needs to know whether an account is connected, when it
// last synced, and whether anything went wrong. It cannot read ig_accounts
// directly -- that table denies the anon key on purpose, because it holds the
// access token -- so this endpoint returns the safe fields only.
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    return res.status(200).json({ configured: false, reason: "Server is missing SUPABASE_SERVICE_ROLE_KEY." });
  }
  if (!process.env.FB_APP_ID || !process.env.FB_APP_SECRET) {
    return res.status(200).json({ configured: false, reason: "Server is missing FB_APP_ID / FB_APP_SECRET." });
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await supabase
    .from("ig_accounts")
    // Deliberately NOT access_token.
    .select("ig_user_id, username, account_type, token_expires, connected_by, connected_at, last_synced_at, last_sync_error");

  if (error) return res.status(500).json({ configured: true, error: error.message });

  const accounts = (data || []).map((a) => ({
    ...a,
    // Surfaced so the UI can nag before a dead token silently stops collection.
    daysUntilExpiry: a.token_expires
      ? Math.round((Date.parse(a.token_expires) - Date.now()) / 86400000)
      : null,
  }));

  res.status(200).json({ configured: true, accounts });
}
