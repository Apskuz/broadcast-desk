// Step 2 of connecting an Instagram account. Instagram sends the person back
// here with a one-time code; we trade it for a 60-day token and store it.
//
// Three hops, because Meta makes you do all three:
//   code -> short-lived token  (POST api.instagram.com/oauth/access_token)
//   short-lived -> long-lived  (GET  graph.instagram.com/access_token)
//   long-lived -> who is this  (GET  graph.instagram.com/me)
import { createClient } from "@supabase/supabase-js";
import { redirectUri } from "./instagram-connect.js";

const GRAPH = "https://graph.instagram.com";

// Note the service role key, not the anon key the other functions use: the
// ig_accounts table holds a live credential and denies anon entirely, so this
// is the only key that can write it. It must never reach the browser.
function db() {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Send people back to the app with a short message rather than leaving them
// staring at raw JSON on an API URL.
function done(res, ok, message) {
  const q = ok ? `ig=connected&name=${encodeURIComponent(message)}` : `ig=failed&why=${encodeURIComponent(message)}`;
  res.redirect(302, `/?${q}`);
}

export default async function handler(req, res) {
  const { code, error, error_description: errorDescription } = req.query || {};

  // The person hit "Cancel" on Instagram's consent screen, or Meta rejected it.
  if (error) return done(res, false, errorDescription || error);
  if (!code) return done(res, false, "Instagram didn't send back an authorization code.");

  const supabase = db();
  if (!supabase) return done(res, false, "Server is missing SUPABASE_SERVICE_ROLE_KEY.");

  const appId = process.env.IG_APP_ID;
  const appSecret = process.env.IG_APP_SECRET;
  if (!appId || !appSecret) return done(res, false, "Server is missing IG_APP_ID / IG_APP_SECRET.");

  try {
    // 1. Code -> short-lived token. This one is form-encoded, unlike every
    //    other Instagram endpoint, and the code dies after a single use.
    const form = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri(req),
      code: String(code),
    });
    const shortRes = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const shortJson = await shortRes.json();
    if (!shortRes.ok || !shortJson.access_token) {
      return done(res, false, shortJson.error_message || shortJson.error?.message || "Token exchange failed.");
    }

    // 2. Short-lived (1 hour) -> long-lived (60 days). Skipping this would mean
    //    the sync job breaks before it ever runs twice.
    const longUrl =
      `${GRAPH}/access_token?grant_type=ig_exchange_token` +
      `&client_secret=${encodeURIComponent(appSecret)}` +
      `&access_token=${encodeURIComponent(shortJson.access_token)}`;
    const longRes = await fetch(longUrl);
    const longJson = await longRes.json();
    if (!longRes.ok || !longJson.access_token) {
      return done(res, false, longJson.error?.message || "Couldn't get a long-lived token.");
    }

    const token = longJson.access_token;
    const expiresAt = new Date(Date.now() + (Number(longJson.expires_in) || 5184000) * 1000);

    // 3. Who did we just connect?
    const meRes = await fetch(`${GRAPH}/me?fields=user_id,username,account_type&access_token=${encodeURIComponent(token)}`);
    const me = await meRes.json();
    if (!meRes.ok || !(me.user_id || me.id)) {
      return done(res, false, me.error?.message || "Couldn't read the account profile.");
    }

    let profile = "";
    try {
      profile = JSON.parse(Buffer.from(String(req.query.state || ""), "base64url").toString()).profile || "";
    } catch { /* state is optional garnish; a missing one is not worth failing over */ }

    const { error: writeError } = await supabase.from("ig_accounts").upsert({
      ig_user_id: String(me.user_id || me.id),
      username: me.username || null,
      account_type: me.account_type || null,
      access_token: token,
      token_expires: expiresAt.toISOString(),
      connected_by: profile || null,
      connected_at: new Date().toISOString(),
      last_sync_error: null,
    }, { onConflict: "ig_user_id" });

    if (writeError) return done(res, false, `Couldn't save the connection: ${writeError.message}`);

    return done(res, true, me.username || "account");
  } catch (err) {
    return done(res, false, err.message || "Something went wrong connecting Instagram.");
  }
}
