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

    const updated = {
      ...board,
      calendarEvents: (board.calendarEvents || []).map((e) =>
        dueEvents.some((d) => d.id === e.id) ? { ...e, dailyDigestSentDate: todayIso } : e
      ),
    };
    await supabase.from("hub_state").update({ data: updated, updated_at: new Date().toISOString() }).eq("id", "main");

    return res.status(200).json({ sent });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
