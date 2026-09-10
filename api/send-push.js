// This runs on Vercel's server, not in the browser — the VAPID private key stays secret here.
import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:admin@example.com",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { toProfile, title, body, fromProfile } = req.body;

    let query = supabase.from("push_subscriptions").select("*");
    if (toProfile) query = query.eq("profile_name", toProfile);
    // Broadcasting to everyone shouldn't push a lock-screen alert to the person
    // who triggered it about their own message/announcement.
    else if (fromProfile) query = query.neq("profile_name", fromProfile);
    const { data: subs, error } = await query;

    if (error) return res.status(500).json({ error: error.message });
    if (!subs || subs.length === 0) return res.status(200).json({ sent: 0 });

    const payload = JSON.stringify({ title, body, url: "/" });

    let sent = 0;
    await Promise.all(
      subs.map(async (s) => {
        const subscription = {
          endpoint: s.endpoint,
          keys: { p256dh: s.p256dh, auth: s.auth },
        };
        try {
          await webpush.sendNotification(subscription, payload);
          sent++;
        } catch (err) {
          // Subscription is dead (user revoked permission, uninstalled, etc.) — clean it up.
          if (err.statusCode === 404 || err.statusCode === 410) {
            await supabase.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
          }
        }
      })
    );

    return res.status(200).json({ sent });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
