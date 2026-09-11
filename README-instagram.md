# Instagram analytics — setup

One-time setup. About 20 minutes, most of it waiting on Meta's dashboard.

**Do the database step and the first sync as soon as you can, even if you don't
care about the charts yet.** Instagram reports a post's numbers only as they are
*right now* — it keeps no history and there is no way to ask for last week's.
Every growth curve in this app is built from daily snapshots the sync job takes,
so collection can only ever start from today forward. Account-level numbers are
the one exception: Meta keeps 90 days of those, and the first sync backfills them.

---

## Why this uses Facebook login, not Instagram login

Meta splits Instagram API access in two, and the simpler-sounding one is not
enough:

| | Instagram login | **Facebook login** (what this uses) |
|---|---|---|
| Per-post views, reach, likes, saves, shares | ✅ | ✅ |
| Reels watch time | ✅ | ✅ |
| Follower count over time | ❌ | ✅ |
| Daily account reach / views / profile views | ❌ | ✅ |
| Audience demographics | ❌ | ✅ |
| Needs the IG account linked to a Facebook Page | No | **Yes** |

Meta says so itself on the Instagram-login setup page: *"If you want to be able
to track hashtags and insights, switch to the API setup with Facebook login."*

The practical cost is the Page requirement. The practical benefit, besides the
extra metrics, is durability: this route stores a **Page access token**, which
carries no expiry of its own, where the Instagram-login route dies permanently
at 60 days if a single refresh is ever missed.

---

## 1. The Instagram account

Must be a **Business** or **Creator** account (Instagram → Settings → Account
type and tools), and must be **linked to a Facebook Page** you manage.

To check the link: Instagram → Edit profile → **Page**, or Settings → Business
tools. If nothing is linked, link it there — an empty Page is fine, you never
have to post to it.

## 2. Create the Meta app

1. <https://developers.facebook.com/apps> → **Create app**
2. App type: **Business** ("Yritys")
3. Add the **Instagram** product
4. In the left sidebar under Instagram, open **API setup with Facebook login**
   *(not the Instagram-login one)*
5. Add the **Facebook Login for Business** product if it isn't already there
6. Under **Facebook Login for Business → Settings**, add this to
   **Valid OAuth Redirect URIs**, exactly, no trailing slash:

   ```
   https://YOUR-DOMAIN.vercel.app/api/instagram-callback
   ```

7. Note the **App ID** and **App secret** from **App settings → Basic**
   *(the Facebook ones at the top of the dashboard — NOT the "Instagram app ID"
   shown on the Instagram-login page)*

Leave the app in **development mode**. You are an admin of your own app, so all
the permissions below work without App Review, and nobody else can connect.

### Permissions requested

`instagram_basic`, `instagram_manage_insights`, `pages_show_list`,
`pages_read_engagement` — all read-only. The app cannot post, delete, comment,
or message; those scopes are not requested and the code contains no write calls.

## 3. Environment variables

Vercel → Project → Settings → Environment Variables:

| Variable | Value |
|---|---|
| `FB_APP_ID` | App ID from App settings → Basic |
| `FB_APP_SECRET` | App secret from App settings → Basic |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → `service_role` key |
| `IG_REDIRECT_URI` | *(optional)* pin the callback URL if auto-detection is wrong |
| `IG_GRAPH_VERSION` | *(optional)* defaults to `v26.0`; bump when Meta deprecates it |
| `CRON_SECRET` | *(optional)* if set, `/api/instagram-sync` requires it |

⚠️ **`SUPABASE_SERVICE_ROLE_KEY` is not the anon key.** It bypasses row-level
security, so it belongs only in Vercel's server-side environment — never in a
`VITE_`-prefixed variable, because anything with that prefix is compiled into
the JS bundle every visitor downloads.

## 4. Create the tables

Supabase → SQL Editor → New query → paste all of `supabase-instagram-schema.sql`
→ Run.

These tables deliberately differ from `hub_state`: `ig_accounts` holds live
access tokens, so it denies the public anon key entirely and is reachable only
by the server functions. The stats tables are readable by the app (they are just
your own post numbers) but writable only server-side, so nobody holding the
public key can poison the history.

## 5. Connect and sync

Redeploy so the new environment variables take effect, then open the app →
**Analytics** → **Connect Instagram** → approve on Facebook.

Then hit **Sync now**. The first run pulls up to 500 posts and backfills 90 days
of account history. After that, Vercel Cron runs it nightly at 03:00 UTC.

---

## Things worth knowing

**The connection renews itself.** Syncs use a Page token, which has no expiry.
It descends from a 60-day user token, so once that is past halfway the nightly
job re-extends it and re-reads a fresh Page token. Left running, this never
needs a human. The Analytics screen warns you if fewer than 10 days remain.

**Stories vanish after 24 hours.** Meta deletes story insights on a 24-hour
timer, so a nightly sync catches most stories but one posted and expired between
two runs is gone. Stories also need 5+ viewers before Meta reports anything.

**Carousels report at the album level only** — Meta exposes no per-slide numbers.

**Demographics need 100+ followers.** Under that, Meta returns nothing and the
Audience card stays hidden.

**`impressions` is gone**, replaced by `views` for anything posted after
2 July 2024. The old metric is not backfilled.

**Rate limits.** Roughly 200 calls per hour per user. The sync job stays well
under by refreshing all posts from the last 30 days every night plus a rotating
40 older ones, so a large back catalogue still gets covered over several days.

**If a metric name changes.** Meta renames insight metrics fairly often, and an
unrecognized name fails the whole call. The sync job retries with a smaller
metric set rather than losing the night, and writes what Meta said to
`ig_accounts.last_sync_error`, which the Analytics screen displays. If a column
goes permanently empty, that error message is the place to look first.

**Vercel Hobby allows 2 cron jobs.** This project now uses both (daily reminders
+ Instagram sync).
