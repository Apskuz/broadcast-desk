/* --------------------------------------------------------------------------
 * What you meant to remove.
 *
 * Painting over a thing with a round brush is a blunt way of saying which
 * pixels should go. Nobody traces a mouse exactly: the strokes cover the mouse
 * and a good deal of the desk it is sitting on. Every one of those desk pixels
 * then has to be invented from scratch, which is both wasted work and worse
 * work — a fill is very good at a small hole and merely adequate at a big one.
 * And it is not what was meant. The desk was already right.
 *
 * So before anything is removed, the brush is read as an intention rather than
 * as a literal instruction. The photograph just outside the strokes says what
 * the background around here looks like; any painted pixel that looks like that
 * background, and can be reached from the edge of the strokes without crossing
 * something that does not, is handed back. What is left is the part that does
 * not belong to the background: the thing.
 *
 * Two things keep this honest. It only ever releases pixels connected to the
 * outside, so a dark patch in the middle of the mouse that happens to match a
 * dark patch of desk is not punched out. And if it would release nearly
 * everything, it does nothing at all and lets the brush stand — that means
 * either the background model is wrong or the intention really was to remove a
 * piece of background, and in both cases the person with the brush knows better.
 * ------------------------------------------------------------------------ */

// Work small. This is a question about regions, not pixels, and at full size it
// would cost more than the fill it is trying to make cheaper.
const SCALE_TO = 480;

// How far out to look for "what the background around here is".
const RING = 14;

// Colours are counted in bins rather than compared one by one, so that a desk
// photographed in poor light still counts as one colour despite its noise.
const BITS = 4;                       // 16 levels a channel
const LEVELS = 1 << BITS;
const BIN = 8 - BITS;

// How much of the surroundings has to be one colour before that colour counts
// as "the background around here".
//
// This is the whole difficulty. What surrounds a mouse on a desk is not only
// desk: there is a black keyboard beside it, a bag behind it, and the shadow it
// casts. Accepting every colour that appears nearby means accepting black — and
// then a black mouse looks exactly like background and gets handed back, which
// is how a removal ran and left the mouse sitting there.
//
// So only the materials that actually make up the bulk of the surroundings
// count. The bins are taken commonest first until they accou nt for this much of
// the ring, and the long tail — the keyboard, the cable, the shadow — is left
// out. The desk is what the mouse is on, and the desk is what wins.
const BACKGROUND_SHARE = 0.6;

// And no bin at all below this, so noise cannot contribute.
const MIN_HITS = 3;

// If releasing would leave less than this much of the brush, assume the brush
// was right and do nothing.
const KEEP_AT_LEAST = 0.10;

const idx = (r, g, b) => ((r >> BIN) * LEVELS + (g >> BIN)) * LEVELS + (b >> BIN);

/**
 * Read a brush as an intention.
 *
 * `image` is anything drawable and `mask` a canvas its size whose alpha says
 * what was painted. Returns a new mask canvas covering only the part that does
 * not look like its surroundings — or the original mask, unchanged, when that
 * judgement cannot be made safely.
 */
export function tightenMask(image, mask) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  if (!iw || !ih) return mask;

  const s = Math.min(1, SCALE_TO / Math.max(iw, ih));
  const w = Math.max(8, Math.round(iw * s)), h = Math.max(8, Math.round(ih * s));

  const ic = document.createElement("canvas");
  ic.width = w; ic.height = h;
  const ix = ic.getContext("2d", { willReadFrequently: true });
  ix.drawImage(image, 0, 0, w, h);
  const px = ix.getImageData(0, 0, w, h).data;

  const mc = document.createElement("canvas");
  mc.width = w; mc.height = h;
  const mx = mc.getContext("2d", { willReadFrequently: true });
  mx.drawImage(mask, 0, 0, w, h);
  const mp = mx.getImageData(0, 0, w, h).data;

  const n = w * h;
  const painted = new Uint8Array(n);
  let paintedCount = 0;
  for (let i = 0; i < n; i++) {
    if (mp[i * 4 + 3] > 24) { painted[i] = 1; paintedCount++; }
  }
  if (!paintedCount || paintedCount === n) return mask;

  /* ---- what the background around here looks like ---- */

  // Distance out from the painted area, so the ring can be taken at arm's
  // length rather than immediately against the strokes, where the thing's own
  // shadow and edge still bleed.
  const dist = new Int32Array(n).fill(-1);
  const queue = [];
  for (let i = 0; i < n; i++) if (painted[i]) { dist[i] = 0; queue.push(i); }
  for (let k = 0; k < queue.length; k++) {
    const i = queue[k];
    if (dist[i] >= RING + 4) continue;
    const x = i % w, y = (i / w) | 0;
    const push = (j) => { if (dist[j] < 0) { dist[j] = dist[i] + 1; queue.push(j); } };
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }

  const hits = new Uint16Array(LEVELS * LEVELS * LEVELS);
  let ringCount = 0;
  for (let i = 0; i < n; i++) {
    if (painted[i]) continue;
    const d = dist[i];
    if (d < 3 || d > RING + 3) continue;       // skip the fringe, keep the band
    const p = i * 4;
    const b = idx(px[p], px[p + 1], px[p + 2]);
    if (hits[b] < 65535) hits[b]++;
    ringCount++;
  }
  if (ringCount < 200) return mask;             // too little to judge from

  // Keep only the commonest colours, up to BACKGROUND_SHARE of the ring. What
  // is left out is everything the brush happens to sit near without being on:
  // the keyboard beside the mouse, the cable across the desk, the dark of the
  // room behind it.
  {
    const order = [];
    for (let b = 0; b < hits.length; b++) if (hits[b] >= MIN_HITS) order.push(b);
    order.sort((a, b) => hits[b] - hits[a]);
    let acc = 0;
    const keep = new Set();
    for (const b of order) {
      keep.add(b);
      acc += hits[b];
      if (acc >= ringCount * BACKGROUND_SHARE) break;
    }
    for (let b = 0; b < hits.length; b++) if (!keep.has(b)) hits[b] = 0;
  }

  // Where the picture changes sharply.
  //
  // Colour alone is not enough to say where a thing ends. A mouse has a lit rim
  // and a shadowed one, and somewhere along that range it passes through
  // colours the desk also has — so a flood that only asks "is this background
  // coloured" walks straight in through the highlight and eats a quarter of the
  // mouse. What actually marks the boundary is the step: the silhouette is the
  // sharpest thing for some distance. So the flood is not allowed to cross one.
  const lumAt = (i) => 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  const edge = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = lumAt(i + 1) - lumAt(i - 1), gy = lumAt(i + w) - lumAt(i - w);
      edge[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  // How sharp is "sharp" here? Taken from the background band, so a grainy photo
  // in poor light is judged by its own standards rather than an absolute number.
  const ringEdges = [];
  for (let i = 0; i < n; i++) {
    if (painted[i]) continue;
    const d = dist[i];
    if (d >= 3 && d <= RING + 3) ringEdges.push(edge[i]);
  }
  ringEdges.sort((a, b) => a - b);
  const typicalEdge = ringEdges.length ? ringEdges[Math.floor(ringEdges.length * 0.75)] : 0;
  const edgeLimit = Math.max(6, typicalEdge * 3);

  // Accept neighbouring bins too, so a gradient of the same material does not
  // fall between two boxes.
  const looksLikeBackground = (p) => {
    const r = px[p] >> BIN, g = px[p + 1] >> BIN, b = px[p + 2] >> BIN;
    for (let dr = -1; dr <= 1; dr++) {
      const rr = r + dr; if (rr < 0 || rr >= LEVELS) continue;
      for (let dg = -1; dg <= 1; dg++) {
        const gg = g + dg; if (gg < 0 || gg >= LEVELS) continue;
        for (let db = -1; db <= 1; db++) {
          const bb = b + db; if (bb < 0 || bb >= LEVELS) continue;
          if (hits[(rr * LEVELS + gg) * LEVELS + bb] >= MIN_HITS) return true;
        }
      }
    }
    return false;
  };

  /* ---- hand back the painted pixels that are plainly background ---- */

  // Only from the outside in: something matching in the middle of the thing is
  // still the middle of the thing.
  const release = new Uint8Array(n);
  const front = [];
  for (let i = 0; i < n; i++) {
    if (!painted[i]) continue;
    const x = i % w, y = (i / w) | 0;
    const atEdge = (x === 0 || y === 0 || x === w - 1 || y === h - 1)
      || !painted[i - 1] || !painted[i + 1] || !painted[i - w] || !painted[i + w];
    if (atEdge && looksLikeBackground(i * 4) && edge[i] < edgeLimit) { release[i] = 1; front.push(i); }
  }
  for (let k = 0; k < front.length; k++) {
    const i = front[k], x = i % w, y = (i / w) | 0;
    const push = (j) => {
      if (j < 0 || j >= n || !painted[j] || release[j]) return;
      if (edge[j] >= edgeLimit) return;          // that is the edge of something
      if (!looksLikeBackground(j * 4)) return;
      release[j] = 1; front.push(j);
    };
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }

  let released = 0;
  for (let i = 0; i < n; i++) if (release[i]) released++;
  if (!released) return mask;

  // Leave a collar of a couple of pixels around whatever is being kept, so the
  // thing's own soft edge and the shadow under it go with it rather than
  // staying behind as a halo.
  for (let pass = 0; pass < 2; pass++) {
    const grow = [];
    for (let i = 0; i < n; i++) {
      if (!painted[i] || release[i]) continue;
      const x = i % w, y = (i / w) | 0;
      if (x > 0 && release[i - 1]) grow.push(i - 1);
      if (x < w - 1 && release[i + 1]) grow.push(i + 1);
      if (y > 0 && release[i - w]) grow.push(i - w);
      if (y < h - 1 && release[i + w]) grow.push(i + w);
    }
    for (const j of grow) release[j] = 0;
  }

  let kept = 0;
  for (let i = 0; i < n; i++) if (painted[i] && !release[i]) kept++;
  if (kept < paintedCount * KEEP_AT_LEAST) return mask;   // it would take nearly everything
  if (kept === paintedCount) return mask;                 // nothing to give back

  /* ---- back to a full-size mask ---- */

  const tight = document.createElement("canvas");
  tight.width = w; tight.height = h;
  const tx = tight.getContext("2d");
  const out = tx.createImageData(w, h);
  for (let i = 0; i < n; i++) {
    const on = painted[i] && !release[i];
    out.data[i * 4] = 255; out.data[i * 4 + 1] = 255; out.data[i * 4 + 2] = 255;
    out.data[i * 4 + 3] = on ? 255 : 0;
  }
  tx.putImageData(out, 0, 0);

  const full = document.createElement("canvas");
  full.width = iw; full.height = ih;
  const fx = full.getContext("2d");
  fx.imageSmoothingEnabled = true;
  fx.drawImage(tight, 0, 0, iw, ih);
  return full;
}
