// Run once a day by Vercel Cron (see vercel.json). On Mondays it also sends
// last week's Instagram summary. Mainly it is the backup for calendar
// reminders — the app itself fires precise reminders while someone has it
// open (see the reminder-check effect in TeamHub), but if nobody has a tab
// open at the exact moment, this guarantees at least a same-day heads-up.
import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:admin@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Same version token the app saves against (see the sync engine in App.jsx):
// microsecond digits so two writers in one millisecond still get told apart.
const nextStamp = (previous) => {
  let ms = Date.now();
  const previousMs = previous ? Date.parse(previous) : NaN;
  if (Number.isFinite(previousMs) && ms <= previousMs) ms = previousMs + 1;
  const micros = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  return new Date(ms).toISOString().replace("Z", `${micros}Z`);
};

// Sending the pushes takes seconds, and the team is using the board the whole
// time. Writing back the copy we read before all that would undo everything
// saved in between — deleted messages back, new pictures gone — so re-read the
// board, touch only the one field this job owns, and save it only if nobody
// else got there first. If they did, read again and reapply.
async function markDigestSent(eventIds, todayIso) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: row, error } = await supabase
      .from("hub_state").select("data, updated_at").eq("id", "main").maybeSingle();
    if (error || !row || !row.data) return false;

    const board = row.data;
    const events = board.calendarEvents || [];
    const stillNeeded = events.some((e) => eventIds.includes(e.id) && e.dailyDigestSentDate !== todayIso);
    if (!stillNeeded) return true;

    const patched = {
      ...board,
      calendarEvents: events.map((e) =>
        eventIds.includes(e.id) ? { ...e, dailyDigestSentDate: todayIso } : e
      ),
    };

    const { data: written } = await supabase
      .from("hub_state")
      .update({ data: patched, updated_at: nextStamp(row.updated_at) })
      .eq("id", "main")
      .eq("updated_at", row.updated_at)
      .select("updated_at");
    if (written && written.length === 1) return true;
  }
  // Worst case the digest goes out twice rather than the board losing a day's work.
  return false;
}

async function pushTo(subs, payload) {
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await supabase.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      }
    }
  }));
  return sent;
}

async function sendDayReminders(board, subs, todayIso) {
  // Someone who switched calendar reminders off in their settings gets no digest either.
  const prefs = board.notificationPrefs || {};
  const dueEvents = (board.calendarEvents || []).filter(
    (e) => e.remind && e.date === todayIso && e.assignee && e.dailyDigestSentDate !== todayIso &&
      !(prefs[e.assignee] && prefs[e.assignee].reminder === false)
  );
  if (dueEvents.length === 0) return 0;
  let sent = 0;
  for (const e of dueEvents) {
    const payload = JSON.stringify({ title: "Today", body: `${e.title}${e.time ? ` at ${e.time}` : ""}`, url: "/?view=calendar" });
    sent += await pushTo(subs.filter((s) => s.profile_name === e.assignee), payload);
  }
  await markDigestSent(dueEvents.map((e) => e.id), todayIso);
  return sent;
}

const compact = (n) => (n >= 10000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n)));
const change = (now, before) => (before ? ` (${now >= before ? "+" : "−"}${Math.abs(Math.round(((now - before) / before) * 100))}%)` : "");

// Mondays: last week on Instagram, next to the week before, to everyone who
// hasn't switched the weekly summary off. Built from the tables the nightly
// Instagram sync fills, so it says nothing until that is connected.
async function weeklySummary(board, subs, todayIso) {
  if (new Date().getUTCDay() !== 1 || board.weeklySummarySentDate === todayIso) return 0;
  const since = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10);
  const { data: days, error } = await supabase.from("ig_account_snapshots").select("day,views,reach,new_followers,followers").gte("day", since).lt("day", todayIso).order("day");
  if (error || !days || days.length < 7) return 0;
  const lastWeekStart = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const week = days.filter((d) => d.day >= lastWeekStart);
  const before = days.filter((d) => d.day < lastWeekStart).slice(-7);
  const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const views = sum(week, "views");
  const follows = sum(week, "new_followers");
  const { data: posts } = await supabase.from("ig_media_latest").select("caption,views,posted_at").gte("posted_at", `${lastWeekStart}T00:00:00Z`).order("views", { ascending: false }).limit(1);
  const best = posts && posts[0];
  const body = [
    `${compact(views)} views${before.length >= 6 ? change(views, sum(before, "views")) : ""}`,
    `${follows} new follows`,
    best ? `best post: "${(best.caption || "untitled").replace(/s+/g, " ").slice(0, 40)}" (${compact(best.views || 0)} views)` : "no new posts",
  ].join(" · ");

  const prefs = board.notificationPrefs || {};
  const muted = new Set(Object.keys(prefs).filter((name) => prefs[name] && prefs[name].weekly === false));
  const sent = await pushTo(subs.filter((s) => !muted.has(s.profile_name)), JSON.stringify({ title: "Last week on Instagram", body, url: "/?view=analytics" }));

  await patchBoard((b) => {
    if (b.weeklySummarySentDate === todayIso) return null;
    const row = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), toProfile: null, type: "weekly", cat: "weekly", text: `Last week on Instagram: ${body}`, link: "analytics", date: todayIso, readBy: [] };
    return { ...b, weeklySummarySentDate: todayIso, notifications: [...(b.notifications || []), row] };
  });
  return sent;
}

// The same careful write as markDigestSent, for any one change: re-read the
// board, apply the change, and save only if nobody saved in between.
async function patchBoard(apply) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: row, error } = await supabase.from("hub_state").select("data, updated_at").eq("id", "main").maybeSingle();
    if (error || !row || !row.data) return false;
    const patched = apply(row.data);
    if (!patched) return true;
    const { data: written } = await supabase
      .from("hub_state")
      .update({ data: patched, updated_at: nextStamp(row.updated_at) })
      .eq("id", "main")
      .eq("updated_at", row.updated_at)
      .select("updated_at");
    if (written && written.length === 1) return true;
  }
  return false;
}

export default async function handler(req, res) {
  try {
    const { data: row, error } = await supabase.from("hub_state").select("data").eq("id", "main").single();
    if (error) return res.status(500).json({ error: error.message });
    const board = row && row.data;
    if (!board) return res.status(200).json({ sent: 0 });

    const todayIso = new Date().toISOString().slice(0, 10);
    const { data: subs } = await supabase.from("push_subscriptions").select("*");
    const reminders = await sendDayReminders(board, subs || [], todayIso);
    let weekly = 0;
    try { weekly = await weeklySummary(board, subs || [], todayIso); } catch { /* the reminders already went out */ }
    return res.status(200).json({ sent: reminders + weekly, reminders, weekly });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
