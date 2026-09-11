/* --------------------------------------------------------------------------
 * Three-way merge for the shared board.
 *
 * The whole team works on one JSON document in Supabase (`hub_state.data`).
 * Every edit used to be written as "here is my entire copy of the board" —
 * so whoever saved last silently replaced everyone else's work: deleted
 * messages came back, freshly added folders and pictures vanished. Screens
 * that had been open for a while were the worst offenders, because their copy
 * of the board was the oldest.
 *
 * The fix is to stop treating a save as a snapshot and start treating it as a
 * change. Given the version the editor started from (`base`), what they now
 * want (`mine`), and what the board actually looks like (`theirs`), this works
 * out which side touched what and keeps both sides' work.
 *
 * The rules, in order:
 *   - only one side changed a thing  -> take that side's version
 *   - both sides changed a list of {id, ...} records -> merge record by record
 *   - a record deleted on either side stays deleted (a delete always wins over
 *     an edit — "I deleted it and it came back" is the bug we're fixing)
 *   - both sides edited the same record -> keep their fields, lay mine on top,
 *     recursing into nested lists like comments and steps
 *   - anything else (plain text, numbers, ordering lists) -> the editor wins
 * ------------------------------------------------------------------------ */

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasId = (v) => isPlainObject(v) && (typeof v.id === "string" || typeof v.id === "number");

// Lists of records we can line up by id — ideas, messages, tasks, board items.
// An empty list qualifies, so clearing one out still merges record by record
// rather than being treated as one opaque value.
const isRecordList = (v) => Array.isArray(v) && v.every(hasId);

export function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aArray = Array.isArray(a);
  if (aArray !== Array.isArray(b)) return false;
  if (aArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

const byId = (list) => {
  const map = new Map();
  for (const item of list) map.set(item.id, item);
  return map;
};

function mergeRecordLists(base, mine, theirs) {
  const inBase = byId(base);
  const inMine = byId(mine);
  const inTheirs = byId(theirs);
  const merged = [];

  // Walk my order first, so where I put things is what I keep seeing.
  for (const item of mine) {
    const was = inBase.get(item.id);
    const now = inTheirs.get(item.id);
    if (was && !now) continue;            // they deleted it while I held a copy
    if (!now) { merged.push(item); continue; } // I just added it
    merged.push(mergeValue(was, item, now));
  }

  // Then fold in what they added, roughly where they put it — so their new
  // note lands at the top of the list if that is where they added it, and at
  // the bottom if that is where it belongs.
  for (let i = 0; i < theirs.length; i++) {
    const item = theirs[i];
    if (inMine.has(item.id)) continue;
    if (inBase.has(item.id)) continue;    // not new — I deleted it, keep it gone
    merged.splice(Math.min(i, merged.length), 0, item);
  }

  return merged;
}

function mergeObjects(base, mine, theirs) {
  const out = {};
  const keys = new Set([
    ...Object.keys(isPlainObject(base) ? base : {}),
    ...Object.keys(isPlainObject(mine) ? mine : {}),
    ...Object.keys(isPlainObject(theirs) ? theirs : {}),
  ]);
  for (const k of keys) {
    out[k] = mergeValue(
      isPlainObject(base) ? base[k] : undefined,
      isPlainObject(mine) ? mine[k] : undefined,
      isPlainObject(theirs) ? theirs[k] : undefined
    );
  }
  return out;
}

function mergeValue(base, mine, theirs) {
  if (deepEqual(mine, theirs)) return mine;
  if (deepEqual(base, mine)) return theirs;   // I never touched this
  if (deepEqual(base, theirs)) return mine;   // they never touched this
  if (isRecordList(base) && isRecordList(mine) && isRecordList(theirs)) {
    return mergeRecordLists(base, mine, theirs);
  }
  if (isPlainObject(mine) && isPlainObject(theirs)) {
    return mergeObjects(base, mine, theirs);
  }
  // Free text, a number, a list of ids used purely for ordering: there is no
  // sensible half-way point, so the person doing the editing wins.
  return mine;
}

// Rebase one edit onto another. `base` is the board the editor started from.
export function mergeState(base, mine, theirs) {
  if (!base || !theirs) return mine;
  if (!mine) return theirs;
  if (mine === theirs) return mine;
  return mergeObjects(base, mine, theirs);
}
