// Writing to the shared board from a server job, without undoing anyone's
// work: re-read the board, apply one change, and save only if nobody else
// saved in between (the same version check the app uses). Lives outside /api
// so Vercel doesn't make a route of it.

// Same version token the app saves against (see the sync engine in App.jsx):
// microsecond digits so two writers in one millisecond still get told apart.
export const nextStamp = (previous) => {
  let ms = Date.now();
  const previousMs = previous ? Date.parse(previous) : NaN;
  if (Number.isFinite(previousMs) && ms <= previousMs) ms = previousMs + 1;
  const micros = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  return new Date(ms).toISOString().replace("Z", `${micros}Z`);
};

// apply(board) returns the changed board, or null to leave it alone.
export async function patchBoard(supabase, apply) {
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

export const rowId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Who has switched a kind of notification off, from the board's settings.
export function mutedFor(board, cat) {
  const prefs = board.notificationPrefs || {};
  return new Set(Object.keys(prefs).filter((name) => prefs[name] && prefs[name][cat] === false));
}
