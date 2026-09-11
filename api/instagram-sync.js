// Pulls Instagram numbers and stores them. Runs daily on Vercel Cron (see
// vercel.json) and can also be triggered by hand from the Analytics screen.
//
// WHY THIS JOB EXISTS AT ALL: Meta only ever tells you what a post looks like
// right now. There is no endpoint for "what did this reel have on Tuesday".
// So every growth curve in the app is built from rows this job wrote, and a
// day the job does not run is a hole nobody can backfill later.
//
// Two consequences shape the code below:
//   - It is idempotent. Re-running it on the same day overwrites that day's
//     row rather than doubling it, so a retry after a failure is always safe.
//   - It never lets one bad metric sink the run. Meta renames and deprecates
//     insight metrics regularly (impressions -> views in 2024), and an unknown
//     metric fails the WHOLE call, so each call falls back to a smaller metric
//     set rather than losing the day's data entirely.
import { createClient } from "@supabase/supabase-js";
import { GRAPH_VERSION } from "./instagram-connect.js";

export const config = { maxDuration: 60 };

// Facebook's host, not graph.instagram.com: account-level insights and audience
// demographics only exist on this side of Meta's split. See instagram-connect.js
// for why this route was chosen.
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Insight metrics Meta accepts per media type. The "extra" ones are the most
// likely to churn, so they are requested as a second choice and dropped on
// error while the core set still lands.
const CORE = ["views", "reach", "likes", "comments", "saved", "shares", "total_interactions"];
const EXTRA_BY_TYPE = {
  FEED: ["follows", "profile_visits"],
  STORY: ["replies", "navigation", "profile_visits", "follows"],
  REELS: ["ig_reels_avg_watch_time", "ig_reels_video_view_total_time"],
};
// Stories have no likes/comments/saves; asking for them errors the whole call.
const CORE_BY_TYPE = {
  STORY: ["views", "reach", "shares", "total_interactions"],
};

// Posts older than this barely move, so they refresh on a slow rotation rather
// than every night. Keeps a big back catalogue inside Meta's rate limit.
const FRESH_DAYS = 30;
const STALE_PER_RUN = 40;

function db() {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Server is missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function graph(path, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${GRAPH}/${path}?${qs}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = new Error(json.error?.message || `Instagram API returned ${res.status}`);
    e.code = json.error?.code;
    throw e;
  }
  return json;
}

// The page token this syncs with carries no expiry of its own, so most nights
// this does nothing. But it is derived from a user token that DOES expire at 60
// days, and a page token outlives its parent only until Meta notices. So once
// the user token is past halfway, re-extend it and re-read a fresh page token
// from it. Done nightly, the connection renews itself indefinitely.
async function refreshTokenIfNeeded(supabase, account) {
  const expires = account.token_expires ? Date.parse(account.token_expires) : 0;
  const daysLeft = (expires - Date.now()) / 86400000;
  if (!account.user_token || !expires || daysLeft > 30) return account.access_token;

  try {
    const renewed = await graph("oauth/access_token", {
      grant_type: "fb_exchange_token",
      client_id: process.env.FB_APP_ID,
      client_secret: process.env.FB_APP_SECRET,
      fb_exchange_token: account.user_token,
    });
    if (!renewed.access_token) return account.access_token;

    // Re-read the page token from the renewed user token, so both stay fresh.
    let pageToken = account.access_token;
    try {
      const pages = await graph("me/accounts", {
        fields: "id,access_token,instagram_business_account{id}",
        limit: "100",
        access_token: renewed.access_token,
      });
      const mine = (pages.data || []).find(
        (p) => String(p.instagram_business_account?.id) === String(account.ig_user_id)
      );
      if (mine?.access_token) pageToken = mine.access_token;
    } catch { /* keep the existing page token; it is usually still valid */ }

    const newExpiry = new Date(Date.now() + (Number(renewed.expires_in) || 5184000) * 1000).toISOString();
    await supabase.from("ig_accounts")
      .update({ access_token: pageToken, user_token: renewed.access_token, token_expires: newExpiry })
      .eq("ig_user_id", account.ig_user_id);
    return pageToken;
  } catch {
    // A failed renewal is not fatal today -- the current token still works. It
    // becomes fatal in 30 days, which is what last_sync_error is there to warn
    // about while there is still time to reconnect.
    return account.access_token;
  }
}

// Ask for core + extra metrics; on rejection retry with core only; on a second
// rejection give up on this post and carry on with the rest.
async function fetchInsights(mediaId, productType, token) {
  const core = CORE_BY_TYPE[productType] || CORE;
  const extra = EXTRA_BY_TYPE[productType] || [];
  const attempts = extra.length ? [[...core, ...extra], core] : [core];

  for (const metrics of attempts) {
    try {
      const json = await graph(`${mediaId}/insights`, { metric: metrics.join(","), access_token: token });
      const out = {};
      for (const row of json.data || []) {
        const v = row.values?.[0]?.value ?? row.total_value?.value ?? null;
        out[row.name] = typeof v === "number" ? v : null;
      }
      return out;
    } catch {
      // fall through to the smaller metric set
    }
  }
  return null;
}

async function syncMedia(supabase, account, token, report) {
  // Meta paginates media; walk a few pages so a first run picks up a real back
  // catalogue without running forever.
  let params = {
    fields: "id,media_type,media_product_type,caption,permalink,thumbnail_url,media_url,timestamp",
    limit: "100",
    access_token: token,
  };
  const media = [];
  for (let page = 0; page < 5; page++) {
    // Addressed by the IG account id: a page token can reach several accounts,
    // so "me" would be ambiguous here in a way it was not on the Instagram host.
    const json = await graph(`${account.ig_user_id}/media`, params);
    media.push(...(json.data || []));
    const next = json.paging?.cursors?.after;
    if (!next || !json.paging?.next) break;
    params = { ...params, after: next };
  }
  report.mediaSeen = media.length;

  if (media.length) {
    const { error } = await supabase.from("ig_media").upsert(
      media.map((m) => ({
        id: m.id,
        ig_user_id: account.ig_user_id,
        media_type: m.media_type || null,
        media_product_type: m.media_product_type || null,
        caption: m.caption || null,
        permalink: m.permalink || null,
        thumbnail_url: m.thumbnail_url || null,
        media_url: m.media_url || null,
        posted_at: m.timestamp || null,
      })),
      { onConflict: "id" }
    );
    if (error) report.errors.push(`saving posts: ${error.message}`);
  }

  // Decide which posts get their insights pulled tonight: everything recent,
  // plus a rotating slice of the back catalogue, oldest-snapshot first.
  const cutoff = Date.now() - FRESH_DAYS * 86400000;
  const fresh = media.filter((m) => Date.parse(m.timestamp || 0) >= cutoff);
  const stale = media.filter((m) => Date.parse(m.timestamp || 0) < cutoff);

  const lastByMedia = new Map();
  if (stale.length) {
    const { data: lastSeen } = await supabase
      .from("ig_media_snapshots")
      .select("media_id, captured_at")
      .in("media_id", stale.slice(0, 500).map((m) => m.id))
      .order("captured_at", { ascending: false });
    for (const row of lastSeen || []) {
      if (!lastByMedia.has(row.media_id)) lastByMedia.set(row.media_id, row.captured_at);
    }
  }
  stale.sort((a, b) => {
    const ta = Date.parse(lastByMedia.get(a.id) || 0) || 0;
    const tb = Date.parse(lastByMedia.get(b.id) || 0) || 0;
    return ta - tb; // never-snapshotted first, then longest-ago
  });

  const targets = [...fresh, ...stale.slice(0, STALE_PER_RUN)];
  const today = new Date().toISOString().slice(0, 10);
  const rows = [];

  for (const m of targets) {
    const ins = await fetchInsights(m.id, m.media_product_type || "FEED", token);
    if (!ins) { report.insightsSkipped++; continue; }
    rows.push({
      media_id: m.id,
      captured_at: `${today}T12:00:00.000Z`, // one canonical row per post per day
      views: ins.views ?? null,
      reach: ins.reach ?? null,
      likes: ins.likes ?? null,
      comments: ins.comments ?? null,
      saved: ins.saved ?? null,
      shares: ins.shares ?? null,
      total_interactions: ins.total_interactions ?? null,
      follows: ins.follows ?? null,
      profile_visits: ins.profile_visits ?? null,
      avg_watch_time_ms: ins.ig_reels_avg_watch_time ?? null,
      total_watch_time_ms: ins.ig_reels_video_view_total_time ?? null,
    });
  }

  // Chunked so one oversized payload cannot fail the whole night.
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await supabase
      .from("ig_media_snapshots")
      .upsert(rows.slice(i, i + 100), { onConflict: "media_id,captured_at" });
    if (error) report.errors.push(`saving post stats: ${error.message}`);
  }
  report.insightsSaved = rows.length;
}

// Account-level daily numbers. Meta keeps 90 days but serves only 30 per call,
// so the first run walks back in chunks and later runs just top up.
async function syncAccount(supabase, account, token, report) {
  const { count } = await supabase
    .from("ig_account_snapshots")
    .select("id", { count: "exact", head: true })
    .eq("ig_user_id", account.ig_user_id);

  const daysBack = count ? 30 : 90; // first run backfills the full window
  const byDay = new Map();

  const record = (day, key, value) => {
    if (!byDay.has(day)) byDay.set(day, { ig_user_id: account.ig_user_id, day });
    byDay.get(day)[key] = value;
  };

  const SERIES = {
    reach: "reach",
    views: "views",
    profile_views: "profile_views",
    website_clicks: "website_clicks",
    follower_count: "followers",
  };

  for (let chunk = 0; chunk * 30 < daysBack; chunk++) {
    const until = Math.floor((Date.now() - chunk * 30 * 86400000) / 1000);
    const since = until - 30 * 86400;

    // One metric per call: a single unsupported name would otherwise void the
    // entire window, and these are exactly the names Meta keeps changing.
    for (const [metric, column] of Object.entries(SERIES)) {
      try {
        const json = await graph(`${account.ig_user_id}/insights`, {
          metric, period: "day", since: String(since), until: String(until), access_token: token,
        });
        for (const row of json.data || []) {
          for (const v of row.values || []) {
            if (typeof v.value === "number" && v.end_time) {
              record(v.end_time.slice(0, 10), column, v.value);
            }
          }
        }
      } catch (err) {
        if (chunk === 0) report.errors.push(`account ${metric}: ${err.message}`);
      }
    }
  }

  const rows = [...byDay.values()];
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await supabase
      .from("ig_account_snapshots")
      .upsert(rows.slice(i, i + 100), { onConflict: "ig_user_id,day" });
    if (error) report.errors.push(`saving account stats: ${error.message}`);
  }
  report.accountDays = rows.length;
}

// Audience breakdown. Meta withholds this entirely under 100 followers, which
// is a rule rather than an error worth shouting about.
async function syncDemographics(supabase, account, token, report) {
  const rows = [];
  for (const breakdown of ["age", "gender", "city", "country"]) {
    try {
      const json = await graph(`${account.ig_user_id}/insights`, {
        metric: "follower_demographics",
        period: "lifetime",
        metric_type: "total_value",
        breakdown,
        access_token: token,
      });
      const results = json.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
      for (const r of results) {
        const label = (r.dimension_values || []).join(", ");
        if (label) {
          rows.push({
            ig_user_id: account.ig_user_id,
            breakdown,
            label,
            value: r.value || 0,
            captured_at: new Date().toISOString(),
          });
        }
      }
    } catch {
      // under 100 followers, or the breakdown was renamed -- neither is fatal
    }
  }
  if (rows.length) {
    const { error } = await supabase
      .from("ig_demographics")
      .upsert(rows, { onConflict: "ig_user_id,breakdown,label" });
    if (error) report.errors.push(`saving demographics: ${error.message}`);
  }
  report.demographics = rows.length;
}

export default async function handler(req, res) {
  // Vercel Cron sends a bearer token when CRON_SECRET is set; the Analytics
  // screen calls it with ?key=. Only enforced when the secret is configured.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}` && req.query.key !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  let supabase;
  try { supabase = db(); } catch (e) { return res.status(500).json({ error: e.message }); }

  const { data: accounts, error } = await supabase.from("ig_accounts").select("*");
  if (error) return res.status(500).json({ error: error.message });
  if (!accounts?.length) return res.status(200).json({ ok: true, note: "No Instagram account connected yet." });

  const reports = [];
  for (const account of accounts) {
    const report = {
      account: account.username || account.ig_user_id,
      mediaSeen: 0, insightsSaved: 0, insightsSkipped: 0,
      accountDays: 0, demographics: 0, errors: [],
    };
    try {
      const token = await refreshTokenIfNeeded(supabase, account);
      await syncMedia(supabase, account, token, report);
      await syncAccount(supabase, account, token, report);
      await syncDemographics(supabase, account, token, report);
    } catch (err) {
      report.errors.push(err.message);
    }
    await supabase.from("ig_accounts").update({
      last_synced_at: new Date().toISOString(),
      last_sync_error: report.errors.length ? report.errors.join(" | ").slice(0, 500) : null,
    }).eq("ig_user_id", account.ig_user_id);
    reports.push(report);
  }

  res.status(200).json({ ok: true, syncedAt: new Date().toISOString(), reports });
}
