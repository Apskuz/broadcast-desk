// Step 1 of connecting an Instagram account: bounce the person to Instagram's
// consent screen. Same principle as the Drive functions -- the app secret only
// ever exists here on the server, never in the bundle.
//
// This endpoint is safe to leave open. While the Meta app is in development
// mode, Instagram itself refuses to authorize anyone who is not added as a
// tester on the app, so a stranger who finds this URL just gets bounced by
// Meta's own login. If you ever take the app live, gate this.

const SCOPES = ["instagram_business_basic", "instagram_business_manage_insights"];

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
  const appId = process.env.IG_APP_ID;
  if (!appId || !process.env.IG_APP_SECRET) {
    return res.status(500).send(
      "Instagram isn't connected yet - the server is missing IG_APP_ID / IG_APP_SECRET."
    );
  }

  // Who clicked connect, so the account can be attributed in the UI. Carried
  // through OAuth in `state`, which Instagram hands back to the callback.
  const profile = typeof req.query.profile === "string" ? req.query.profile.slice(0, 60) : "";
  const state = Buffer.from(JSON.stringify({ profile, n: Math.random().toString(36).slice(2) }))
    .toString("base64url");

  const url =
    "https://www.instagram.com/oauth/authorize" +
    `?client_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri(req))}` +
    "&response_type=code" +
    `&scope=${encodeURIComponent(SCOPES.join(","))}` +
    `&state=${encodeURIComponent(state)}`;

  res.redirect(302, url);
}
