# Broadcast Desk — setup guide

This is a real, buildable React app (not a Claude artifact) that syncs live
across every device your team uses, via Supabase.

## 1. Open it in VSCode

Unzip this folder and open it in VSCode. In the built-in terminal:

```
npm install
```

## 2. Create the Supabase backend

1. Go to [supabase.com](https://supabase.com) → New project (free tier is fine).
2. Once it's created, go to **SQL Editor → New query**, paste in everything
   from `supabase-schema.sql` in this folder, and click **Run**.
3. Go to **Database → Replication**, find the `hub_state` table, and toggle it
   **on** — this is what makes changes push live to every phone instantly.
4. Go to **Project Settings → API**. You'll need two values from there:
   - **Project URL**
   - **anon public** key

## 3. Connect the app to Supabase

In this project folder, copy `.env.example` to a new file called `.env`, and
paste in the two values from step 2:

```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
```

Now run it locally to check it works:

```
npm run dev
```

Open the URL it gives you. You should see the login screen. Set your lead
passcode, add your first profile, and confirm tasks/notes/etc. save properly.

## 4. Push it to GitHub

```
git init
git add .
git commit -m "Broadcast Desk"
```

Create a new empty repo on [github.com](https://github.com), then:

```
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git branch -M main
git push -u origin main
```

(`.env` is in `.gitignore`, so your Supabase keys won't get committed —
you'll add them separately in Vercel in the next step.)

## 5. Deploy on Vercel

1. Go to [vercel.com](https://vercel.com) → **Add New → Project** → import
   the GitHub repo you just pushed.
2. Vercel will auto-detect it as a Vite project — leave the build settings
   as-is.
3. Before deploying, open **Environment Variables** and add the same two
   values from your `.env`:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Click **Deploy**.

You'll get a URL like `broadcast-desk.vercel.app` — send that to your 5
teammates. Everyone hits the same live Supabase data, so a duty assigned,
a comment left, or a note added on one phone shows up on everyone else's
within a second or two.

## How it stays in sync

Every screen in the app reads and writes one shared object (tasks, calendar,
notes, content, ideas, resources, profiles — all of it) that lives in a single
`hub_state` row in Supabase. When anyone saves a change, Supabase's Realtime
feature pushes the updated row to every other open phone/browser automatically
— nobody needs to refresh.

Each device separately remembers *who's currently checked in on it* using the
browser's own local storage — that part is intentionally per-device, not
shared, so people can log in/out on their own phones independently.

## Updating the app later

Change code in VSCode → commit → `git push`. Vercel redeploys automatically
on every push to `main`. Nobody's saved data is affected — that all lives in
Supabase, completely separate from the app's code.

## Worth knowing

- The Supabase **anon key** ends up visible in your deployed site's JavaScript
  (that's normal for this kind of key), and the database policies in
  `supabase-schema.sql` allow anyone with that key to read/write the board.
  That's an acceptable tradeoff for an internal team tool gated by the
  in-app lead passcode and login codes — but don't put anything sensitive
  in it, and don't share the Supabase dashboard credentials themselves.
- The free Supabase tier is generous for a team of 5 and will comfortably
  cover this use case.
