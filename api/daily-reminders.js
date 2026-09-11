// Run once a day by Vercel Cron (see vercel.json) as a backup for calendar
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

export default async function handler(req, res) {
  try {
    const { data: row, error } = await supabase.from("hub_state").select("data").eq("id", "main").single();
    if (error) return res.status(500).json({ error: error.message });
    const board = row && row.data;
    if (!board) return res.status(200).json({ sent: 0 });

    const todayIso = new Date().toISOString().slice(0, 10);
    const dueEvents = (board.calendarEvents || []).filter(
      (e) => e.remind && e.date === todayIso && e.assignee && e.dailyDigestSentDate !== todayIso
    );
    if (dueEvents.length === 0) return res.status(200).json({ sent: 0 });

    const { data: subs } = await supabase.from("push_subscriptions").select("*");
    let sent = 0;

    for (const e of dueEvents) {
      const mySubs = (subs || []).filter((s) => s.profile_name === e.assignee);
      const payload = JSON.stringify({ title: "Today", body: `${e.title}${e.time ? ` at ${e.time}` : ""}`, url: "/" });
      await Promise.all(
        mySubs.map(async (s) => {
          try {
            await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
            sent++;
          } catch (err) {
            if (err.statusCode === 404 || err.statusCode === 410) {
              await supabase.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
            }
          }
        })
      );
    }

    await markDigestSent(dueEvents.map((e) => e.id), todayIso);

    return res.status(200).json({ sent });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
