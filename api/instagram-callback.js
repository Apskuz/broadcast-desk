// Step 2 of connecting an Instagram account. Facebook sends the person back
// here with a one-time code; we trade it for tokens and find the Instagram
// account hanging off their Page.
//
// Four hops, because Meta routes Instagram access through Facebook Pages:
//   code           -> short-lived user token   (GET oauth/access_token)
//   short-lived    -> long-lived user token    (GET oauth/access_token, fb_exchange)
//   long-lived     -> the Pages they manage    (GET /me/accounts)
//   each Page      -> its Instagram account    (instagram_business_account)
//
// What gets stored is the PAGE token, not the user token. Page tokens derived
// from a long-lived user token carry no expiry of their own, so nightly syncs
// keep working without anyone reconnecting. The user token is kept alongside so
// the connection can renew itself later.
import { createClient } from "@supabase/supabase-js";
import { redirectUri, GRAPH_VERSION } from "./instagram-connect.js";

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Note the service role key, not the anon key the other functions use: the
// ig_accounts table holds live credentials and denies anon entirely, so this is
// the only key that can write it. It must never reach the browser.
function db() {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Send people back to the app with a short message rather than leaving them
// staring at raw JSON on an API URL.
function done(res, ok, message) {
  const q = ok
    ? `ig=connected&name=${encodeURIComponent(message)}`
    : `ig=failed&why=${encodeURIComponent(message)}`;
  res.redirect(302, `/?${q}`);
}

async function graph(path, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${GRAPH}/${path}?${qs}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error?.message || `Facebook returned ${res.status}`);
  return json;
}

const PAGE_FIELDS = "id,name,access_token,instagram_business_account{id,username}";

// me/accounts lists the Pages a person has a role on directly. A Page owned by
// a business portfolio and granted through Facebook Login for Business is
// often missing from it altogether -- the grant is real, it just isn't listed
// there. The token itself records exactly which Pages were ticked in the
// consent dialog, so read them from debug_token and ask for each by id.
async function grantedPages(userToken, appId, appSecret) {
  const debug = await graph("debug_token", { input_token: userToken, access_token: `${appId}|${appSecret}` });
  const ids = new Set();
  for (const s of debug.data?.granular_scopes || []) {
    if (String(s.scope).startsWith("pages_")) (s.target_ids || []).forEach((id) => ids.add(String(id)));
  }
  const pages = [];
  for (const id of ids) {
    try {
      pages.push(await graph(id, { fields: PAGE_FIELDS, access_token: userToken }));
    } catch { /* one unreadable Page shouldn't hide the others */ }
  }
  return pages;
}

export default async function handler(req, res) {
  const { code, error, error_description: errorDescription } = req.query || {};

  // The person hit "Cancel" on Facebook's consent screen, or Meta rejected it.
  if (error) return done(res, false, errorDescription || error);
  if (!code) return done(res, false, "Facebook didn't send back an authorization code.");

  const supabase = db();
  if (!supabase) return done(res, false, "Server is missing SUPABASE_SERVICE_ROLE_KEY.");

  const appId = process.env.FB_APP_ID;
  const appSecret = process.env.FB_APP_SECRET;
  if (!appId || !appSecret) return done(res, false, "Server is missing FB_APP_ID / FB_APP_SECRET.");

  try {
    // 1. Code -> short-lived user token. The code dies after a single use.
    const shortJson = await graph("oauth/access_token", {
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri(req),
      code: String(code),
    });
    if (!shortJson.access_token) return done(res, false, "Token exchange failed.");

    // 2. Short-lived (about an hour) -> long-lived (60 days). Skipping this
    //    would mean the page tokens below inherit the short lifetime too.
    const longJson = await graph("oauth/access_token", {
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortJson.access_token,
    });
    const userToken = longJson.access_token || shortJson.access_token;
    const expiresAt = new Date(Date.now() + (Number(longJson.expires_in) || 5184000) * 1000);

    // 3. Which Pages does this person manage, and which have Instagram attached?
    const pages = await graph("me/accounts", { fields: PAGE_FIELDS, limit: "100", access_token: userToken });
    if (!(pages.data || []).some((p) => p.instagram_business_account?.id)) {
      try {
        const granted = await grantedPages(userToken, appId, appSecret);
        const known = new Set((pages.data || []).map((p) => p.id));
        pages.data = [...(pages.data || []), ...granted.filter((p) => !known.has(p.id))];
      } catch { /* fall through to the explanation below */ }
    }

    const linked = (pages.data || []).filter((p) => p.instagram_business_account?.id);
    if (!linked.length) {
      // Two different problems with two different fixes, so say which one:
      // Facebook handed over no Pages at all (none ticked in the consent
      // dialog, or access only through a business portfolio), or it handed
      // over Pages that have no Instagram account attached.
      const seen = (pages.data || []).map((p) => p.name || p.id);
      if (!seen.length) {
        return done(res, false,
          "Facebook gave the app no Pages. Connect again and tick the Tulisielu Page " +
          "(and its Instagram account) when Facebook asks which ones to share.");
      }
      return done(res, false,
        `Facebook shared these Pages: ${seen.join(", ")} — but none has an Instagram ` +
        "account linked, or the Instagram account wasn't ticked. Check the Page's " +
        "Settings > Linked accounts > Instagram, then connect again.");
    }

    let profile = "";
    try {
      profile = JSON.parse(Buffer.from(String(req.query.state || ""), "base64url").toString()).profile || "";
    } catch { /* state is optional garnish; a missing one is not worth failing over */ }

    // Store every linked account. Most people have one; someone running several
    // brands gets them all rather than silently losing the others.
    const rows = linked.map((p) => ({
      ig_user_id: String(p.instagram_business_account.id),
      username: p.instagram_business_account.username || null,
      account_type: "BUSINESS",
      // The page token -- what syncs actually use. A Page read by id comes back
      // without one when the person's access is through a business portfolio;
      // the user token can read the same Instagram insights, it just needs
      // renewing, which the nightly sync does.
      access_token: p.access_token || userToken,
      user_token: userToken,
      token_expires: expiresAt.toISOString(),
      page_id: p.id,
      page_name: p.name || null,
      connected_by: profile || null,
      connected_at: new Date().toISOString(),
      last_sync_error: null,
    }));

    const { error: writeError } = await supabase
      .from("ig_accounts").upsert(rows, { onConflict: "ig_user_id" });
    if (writeError) return done(res, false, `Couldn't save the connection: ${writeError.message}`);

    const names = rows.map((r) => r.username || r.ig_user_id).join(", ");
    return done(res, true, names);
  } catch (err) {
    return done(res, false, err.message || "Something went wrong connecting Instagram.");
  }
}
