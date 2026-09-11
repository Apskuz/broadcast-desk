// Step 1 of connecting an Instagram account: bounce the person to Facebook's
// consent screen. The app secret only ever exists here on the server, never in
// the bundle -- same principle as the Drive functions.
//
// WHY FACEBOOK AND NOT INSTAGRAM LOGIN: Meta splits Instagram access in two.
// "Instagram login" is simpler but only exposes per-post insights. Account-level
// numbers -- follower count over time, daily reach, profile views, audience
// demographics -- are only available through "Facebook login", which reaches
// the Instagram account via the Facebook Page it is linked to. Meta says as
// much on the Instagram login setup page: "if you want to be able to track
// hashtags and insights, switch to the API setup with Facebook login."
//
// This endpoint is safe to leave open. While the app is in development mode,
// Facebook only authorizes people with a role on the app, so a stranger who
// finds this URL gets refused by Meta's own login.

export const GRAPH_VERSION = process.env.IG_GRAPH_VERSION || "v26.0";

const SCOPES = [
  "instagram_basic",             // read the IG account and its media
  "instagram_manage_insights",   // the actual analytics, post and account level
  "pages_show_list",             // find which Page the IG account hangs off
  "pages_read_engagement",       // read that Page
];

// The redirect_uri has to match what is registered in the Meta app byte for
// byte. Deriving it from the incoming request keeps preview deploys working
// without a second env var, but an explicit IG_REDIRECT_URI always wins.
export function redirectUri(req) {
  if (process.env.IG_REDIRECT_URI) return process.env.IG_REDIRECT_URI;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}/api/instagram-callback`;
}

export default async function handler(req, res) {
  const appId = process.env.FB_APP_ID;
  if (!appId || !process.env.FB_APP_SECRET) {
    return res.status(500).send(
      "Instagram isn't connected yet - the server is missing FB_APP_ID / FB_APP_SECRET."
    );
  }

  // Who clicked connect, so the account can be attributed in the UI. Carried
  // through OAuth in `state`, which Facebook hands back to the callback.
  const profile = typeof req.query.profile === "string" ? req.query.profile.slice(0, 60) : "";
  const state = Buffer.from(JSON.stringify({ profile, n: Math.random().toString(36).slice(2) }))
    .toString("base64url");

  const url =
    `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri(req))}` +
    "&response_type=code" +
    `&scope=${encodeURIComponent(SCOPES.join(","))}` +
    `&state=${encodeURIComponent(state)}`;

  res.redirect(302, url);
}
