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

## 6. Enable push notifications (optional)

Notifications only work once these are set up — without them the "Enable
notifications" button will show "Couldn't enable — try again", and the
`send-push` function silently finds no one to notify.

1. In this project folder, run `npx web-push generate-vapid-keys`. It prints
   a public and private key.
2. In Vercel → **Settings → Environment Variables**, add:
   - `VITE_VAPID_PUBLIC_KEY` — the public key (needed at build time)
   - `VAPID_PUBLIC_KEY` — the same public key (used server-side)
   - `VAPID_PRIVATE_KEY` — the private key (keep secret)
   - `VAPID_SUBJECT` — `mailto:you@example.com`
3. If your Supabase project already existed before this feature was added,
   re-open **SQL Editor** and run the `push_subscriptions` table block from
   `supabase-schema.sql` (a fresh project already gets it from step 2).
4. Redeploy. On a phone, install the app to the home screen first — iOS
   Safari only supports push for installed PWAs, not the browser tab.

## 7. Enable Drive uploads for Content Review (optional)

Without this, uploading a file in Content Review fails with a network/upload
error — the browser never gets a valid upload session from Google.

The destination folder **must live inside a Shared Drive**, not someone's
personal "My Drive" — Google gives service accounts zero storage quota of
their own, so writing a file to a regular folder fails with a 403 even when
that folder is shared with the service account as an editor. Shared Drives
require a Google Workspace (paid business) account, not a free Gmail.

1. In [Google Cloud Console](https://console.cloud.google.com), create (or
   reuse) a project, enable the **Google Drive API**, then create a
   **Service Account** (IAM & Admin → Service Accounts).
2. Create a JSON key for that service account and open it — you need the
   `client_email` and `private_key` fields.
3. In Google Drive, create a **Shared Drive** (left sidebar → Shared drives →
   New), then create a folder inside it for uploads. Open the Shared Drive's
   **Manage members**, add the service account's email as a **Content
   manager** (or higher). Copy the folder ID from its URL
   (`https://drive.google.com/drive/folders/THIS_PART`).
4. In Vercel → **Settings → Environment Variables**, add:
   - `GDRIVE_CLIENT_EMAIL` — the service account's `client_email`
   - `GDRIVE_PRIVATE_KEY` — the service account's `private_key` (paste as-is,
     including the `\n` sequences and `BEGIN/END PRIVATE KEY` lines)
   - `GDRIVE_FOLDER_ID` — the folder ID from step 3
5. Redeploy.

## Worth knowing

- The Supabase **anon key** ends up visible in your deployed site's JavaScript
  (that's normal for this kind of key), and the database policies in
  `supabase-schema.sql` allow anyone with that key to read/write the board.
  That's an acceptable tradeoff for an internal team tool gated by the
  in-app lead passcode and login codes — but don't put anything sensitive
  in it, and don't share the Supabase dashboard credentials themselves.
- The free Supabase tier is generous for a team of 5 and will comfortably
  cover this use case.
