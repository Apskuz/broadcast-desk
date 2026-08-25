import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  // Fails loudly instead of silently breaking storage — check your .env / Vercel env vars.
  console.error(
    "Missing Supabase config. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY " +
    "in a .env file locally, and in Vercel → Project → Settings → Environment Variables."
  );
}

export const supabase = createClient(url, key);
