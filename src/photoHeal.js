/* --------------------------------------------------------------------------
 * Remove something from a picture.
 *
 * Adobe's version sends the photo to Firefly and gets back pixels a model
 * invented. We cannot do that here — there is no model to call, and calling one
 * would cost money per picture. So this is the other thing, the one that ran
 * inside Photoshop for a decade before Firefly existed: PatchMatch (Barnes et
 * al., 2009), the algorithm behind content-aware fill.
 *
 * It invents nothing. Working inward from the edge of the hole, it hunts the
 * rest of the same photograph for the patch that best fits what is already
 * settled around each pixel, and copies it. That makes it very good at the
 * things people actually want gone from a reference shot — a bin, a sign, a
 * passer-by, a blemish, a wire against a sky — and bad at anything needing an
 * object that is not already somewhere in the frame. Knowing which is which is
 * most of using it well.
 *
 * It runs on the machine looking at it, costs nothing, and needs no network.
 * ------------------------------------------------------------------------ */

const PATCH = 7;                 // odd; the window matched against the rest of the photo
const HALF = (PATCH - 1) / 2;
const WORK = 512;                // longest edge of the window it solves in
const HOLE_BUDGET = 14000;       // most pixels it will ever try to invent at once
const COARSEST = 40;             // stop making the pyramid smaller than this

/* ------------------------------- small helpers ---------------------------- */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// A level of the pyramid: colours as floats, plus which pixels are still hole.
function makeLevel(w, h) {
  return { w, h, rgb: new Float32Array(w * h * 3), hole: new Uint8Array(w * h) };
}

function levelFromImageData(data, w, h, maskData) {
  const level = makeLevel(w, h);
  for (let i = 0, n = w * h; i < n; i++) {
    level.rgb[i * 3] = data[i * 4];
    level.rgb[i * 3 + 1] = data[i * 4 + 1];
    level.rgb[i * 3 + 2] = data[i * 4 + 2];
    // Anything the brush touched at all counts, so a soft edge still removes.
    level.hole[i] = maskData[i * 4 + 3] > 24 ? 1 : 0;
  }
  return level;
}

// Halve a level. A hole pixel contributes no colour — averaging the thing we
// are trying to delete back into the coarse image would be self-defeating —
// and a coarse pixel is hole only if every fine pixel under it was.
function shrink(level) {
  const w = Math.max(1, level.w >> 1), h = Math.max(1, level.h >> 1);
  const out = makeLevel(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, known = 0, total = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(level.w - 1, x * 2 + dx), sy = Math.min(level.h - 1, y * 2 + dy);
          const si = sy * level.w + sx;
          total++;
          if (level.hole[si]) continue;
          r += level.rgb[si * 3]; g += level.rgb[si * 3 + 1]; b += level.rgb[si * 3 + 2];
          known++;
        }
      }
      const oi = y * w + x;
      out.hole[oi] = known === 0 ? 1 : 0;
      if (known) { out.rgb[oi * 3] = r / known; out.rgb[oi * 3 + 1] = g / known; out.rgb[oi * 3 + 2] = b / known; }
      else if (known === 0 && total) { /* left at zero; seeded below */ }
    }
  }
  return out;
}

// Push a solved coarse level up into the next finer one, but only inside the
// hole: everything outside is real photograph and must not be touched.
function upsampleInto(coarse, fine) {
  for (let y = 0; y < fine.h; y++) {
    const cy = Math.min(coarse.h - 1, y >> 1);
    for (let x = 0; x < fine.w; x++) {
      const fi = y * fine.w + x;
      if (!fine.hole[fi]) continue;
      const cx = Math.min(coarse.w - 1, x >> 1);
      const ci = cy * coarse.w + cx;
      fine.rgb[fi * 3] = coarse.rgb[ci * 3];
      fine.rgb[fi * 3 + 1] = coarse.rgb[ci * 3 + 1];
      fine.rgb[fi * 3 + 2] = coarse.rgb[ci * 3 + 2];
    }
  }
}

// Something has to be in the hole before the first search, or every patch is
// matching against black. The mean of what surrounds it is a dull but honest
// starting point, and the search replaces it within an iteration or two.
function seedHole(level) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0, count = level.w * level.h; i < count; i++) {
    if (level.hole[i]) continue;
    r += level.rgb[i * 3]; g += level.rgb[i * 3 + 1]; b += level.rgb[i * 3 + 2];
    n++;
  }
  if (!n) return;
  r /= n; g /= n; b /= n;
  for (let i = 0, count = level.w * level.h; i < count; i++) {
    if (!level.hole[i]) continue;
    level.rgb[i * 3] = r; level.rgb[i * 3 + 1] = g; level.rgb[i * 3 + 2] = b;
  }
}

/* ------------------------------- PatchMatch ------------------------------- */

// How badly a patch centred on the hole side matches one centred on the source
// side. Sum of squared differences, abandoned early once it cannot win.
// Real photograph inside the window counts for far more than the guess
// currently sitting in the hole. Without this the search compares its own
// invention against the world, finds that smooth matches smooth, and settles
// on a flat patch — the fill converges to the average of everything and the
// texture never comes back. Weighting the known pixels up means the boundary
// decides, and propagation carries that decision inward.
const GUESS_WEIGHT = 0.1;

function patchCost(level, ax, ay, bx, by, best) {
  const { w, h, rgb, known } = level;
  let sum = 0;
  for (let dy = -HALF; dy <= HALF; dy++) {
    const ay2 = clamp(ay + dy, 0, h - 1), by2 = clamp(by + dy, 0, h - 1);
    for (let dx = -HALF; dx <= HALF; dx++) {
      const ax2 = clamp(ax + dx, 0, w - 1), bx2 = clamp(bx + dx, 0, w - 1);
      const ap = ay2 * w + ax2;
      const ai = ap * 3, bi = (by2 * w + bx2) * 3;
      const dr = rgb[ai] - rgb[bi], dg = rgb[ai + 1] - rgb[bi + 1], db = rgb[ai + 2] - rgb[bi + 2];
      const weight = known[ap] ? 1 : GUESS_WEIGHT;
      sum += weight * (dr * dr + dg * dg + db * db);
      if (sum >= best) return sum;
    }
  }
  return sum;
}

// The order to fill in: every pixel touching real photograph first, then every
// pixel touching those, and so on inward. Filling the middle first would mean
// choosing it with nothing real to go on.
function bandOrder(level) {
  const { w, h, hole } = level;
  const dist = new Int32Array(w * h).fill(-1);
  const queue = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!hole[i]) continue;
      const edge = (x > 0 && !hole[i - 1]) || (x < w - 1 && !hole[i + 1])
        || (y > 0 && !hole[i - w]) || (y < h - 1 && !hole[i + w]);
      if (edge) { dist[i] = 0; queue.push(i); }
    }
  }
  for (let k = 0; k < queue.length; k++) {
    const i = queue[k], x = i % w, y = (i / w) | 0;
    const push = (j) => { if (j >= 0 && j < w * h && hole[j] && dist[j] < 0) { dist[j] = dist[i] + 1; queue.push(j); } };
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  // Anything the flood never reached (a hole touching nothing real) goes last.
  for (let i = 0, n = w * h; i < n; i++) if (hole[i] && dist[i] < 0) queue.push(i);
  return queue;
}

// A source patch is only usable if nothing inside it is still hole — otherwise
// the fill feeds on itself and smears.
function buildValid(level) {
  const { w, h, hole } = level;
  const valid = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ok = 1;
      for (let dy = -HALF; dy <= HALF && ok; dy++) {
        for (let dx = -HALF; dx <= HALF; dx++) {
          const sx = clamp(x + dx, 0, w - 1), sy = clamp(y + dy, 0, h - 1);
          if (hole[sy * w + sx]) { ok = 0; break; }
        }
      }
      valid[y * w + x] = ok;
    }
  }
  return valid;
}

// Fill one level, boundary inward, committing as it goes.
//
// The first version of this iterated over the whole hole at once and averaged
// every patch that covered a pixel. That converges beautifully to the wrong
// thing: an average of a hundred patches of grass is the colour of grass, not
// grass. Texture is exactly the detail averaging destroys, and the middle of
// the hole never had any real photograph in view to be matched against anyway.
//
// So: one pass, outside in. Each pixel is chosen when its neighbours are
// already settled, copied outright from the single best-fitting patch, and then
// treated as context for the pixels behind it. Nothing is ever averaged, so
// whatever texture the source had arrives intact.
async function solveLevel(level, rng, yieldToPage) {
  const { w, h, hole } = level;
  const valid = buildValid(level);
  const order = bandOrder(level);
  if (!order.length) return;

  const sources = [];
  for (let i = 0, n = w * h; i < n; i++) if (valid[i]) sources.push(i);
  if (!sources.length) return;                 // the brush covered the whole frame

  // Committed-so-far. Starts as the real photograph and grows inward. Source
  // patches are never taken from here — only from `valid`, which is fixed —
  // so the fill can never end up eating its own output.
  level.known = new Uint8Array(w * h);
  for (let i = 0, n = w * h; i < n; i++) level.known[i] = hole[i] ? 0 : 1;

  const nnx = new Int32Array(w * h), nny = new Int32Array(w * h);
  const maxSearch = Math.max(w, h);

  for (let k = 0; k < order.length; k++) {
    if (yieldToPage && (k & 1023) === 1023) await yieldToPage();
    const t = order[k];
    const x = t % w, y = (t / w) | 0;

    let bestCost = Infinity, bx = -1, by = -1;
    const consider = (cx, cy) => {
      const sx = clamp(cx, HALF, w - 1 - HALF), sy = clamp(cy, HALF, h - 1 - HALF);
      if (!valid[sy * w + sx]) return;
      const c = patchCost(level, x, y, sx, sy, bestCost);
      if (c < bestCost) { bestCost = c; bx = sx; by = sy; }
    };

    // Whatever the settled neighbours chose, shifted by one. This is the
    // propagation step, and it is what keeps a filled region coherent instead
    // of a mosaic of unrelated scraps.
    if (x > 0 && nnx[t - 1] >= 0 && level.known[t - 1] && hole[t - 1]) consider(nnx[t - 1] + 1, nny[t - 1]);
    if (x < w - 1 && level.known[t + 1] && hole[t + 1]) consider(nnx[t + 1] - 1, nny[t + 1]);
    if (y > 0 && level.known[t - w] && hole[t - w]) consider(nnx[t - w], nny[t - w] + 1);
    if (y < h - 1 && level.known[t + w] && hole[t + w]) consider(nnx[t + w], nny[t + w] - 1);

    // A handful of random guesses, coarse to fine, to find something better
    // than the neighbours knew about.
    if (bx < 0) {
      const pick = sources[(rng() * sources.length) | 0];
      consider(pick % w, (pick / w) | 0);
    }
    for (let radius = maxSearch; radius >= 1; radius >>= 1) {
      const ox = ((rng() * 2 - 1) * radius) | 0, oy = ((rng() * 2 - 1) * radius) | 0;
      consider((bx < 0 ? x : bx) + ox, (by < 0 ? y : by) + oy);
    }

    if (bx < 0) continue;
    nnx[t] = bx; nny[t] = by;
    const si = (by * w + bx) * 3;
    level.rgb[t * 3] = level.rgb[si];
    level.rgb[t * 3 + 1] = level.rgb[si + 1];
    level.rgb[t * 3 + 2] = level.rgb[si + 2];
    level.known[t] = 1;
  }
}

/* --------------------------------- the job -------------------------------- */

// Where the brush actually went, plus a collar of real photograph around it to
// copy from. Too tight a collar and there is nothing to match against; too wide
// and we are back to solving the whole picture at low resolution.
function maskBounds(mask, iw, ih) {
  const probe = 400;
  const s = Math.min(1, probe / Math.max(iw, ih));
  const pw = Math.max(1, Math.round(iw * s)), ph = Math.max(1, Math.round(ih * s));
  const c = document.createElement("canvas");
  c.width = pw; c.height = ph;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(mask, 0, 0, pw, ph);
  const px = ctx.getImageData(0, 0, pw, ph).data;

  let minX = pw, minY = ph, maxX = -1, maxY = -1;
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      if (px[(y * pw + x) * 4 + 3] <= 24) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;

  let painted = 0;
  for (let i = 0, n = pw * ph; i < n; i++) if (px[i * 4 + 3] > 24) painted++;

  // Back to full-resolution pixels, then grown.
  const x0 = minX / s, y0 = minY / s, x1 = (maxX + 1) / s, y1 = (maxY + 1) / s;
  const pad = Math.max(48, Math.max(x1 - x0, y1 - y0) * 1.6);
  const rx = Math.max(0, Math.floor(x0 - pad));
  const ry = Math.max(0, Math.floor(y0 - pad));
  return {
    x: rx,
    y: ry,
    w: Math.min(iw, Math.ceil(x1 + pad)) - rx,
    h: Math.min(ih, Math.ceil(y1 + pad)) - ry,
    holeArea: painted / (s * s),          // in full-resolution pixels
  };
}

// A fixed seed, so removing the same thing twice gives the same answer. A tool
// that produced a different result every time you pressed it would be
// impossible to judge.
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Fill in whatever the mask covers.
 *
 * `image` is anything drawable, `mask` a canvas the same shape whose alpha says
 * what to remove. Returns a canvas at the image's own size.
 *
 * The solve happens at 512px however big the picture is. Patch matching is
 * O(pixels x iterations x patch) and at full resolution it would take minutes
 * in a browser tab; at 512 it takes a second or two. The filled area is then
 * scaled back up and feathered into the original, so everything outside the
 * brush stays exactly the pixels that came out of the camera — only the part
 * being invented is soft, and invented detail has no fine detail to lose.
 */
export async function healRegion({ image, mask, onProgress }) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;

  const say = (m) => { if (onProgress) onProgress(m); };
  const breathe = () => new Promise((r) => setTimeout(r, 0));

  say("Reading the picture…");

  // Work on a window around what is being removed rather than the whole frame.
  // The solve is capped at WORK pixels either way, so spending all of them on
  // the neighbourhood of a small object means solving it at something near the
  // photo's real resolution — which is the difference between grass that still
  // looks like grass and a smooth green smear. It also means the patch search
  // only ever considers nearby material, which is usually what should fill a
  // hole anyway.
  const region = maskBounds(mask, iw, ih);
  if (!region) return null;

  // Two caps, whichever bites first. The window must fit in WORK, and the hole
  // itself must stay under HOLE_BUDGET pixels — the cost is driven by how many
  // pixels have to be invented, not by how big the picture is, and an unbounded
  // one can lock the tab up for a minute. Paint a small thing and you get a
  // near-native-resolution fill; paint half the frame and it quietly drops the
  // resolution rather than hanging.
  const scale = Math.min(
    1,
    WORK / Math.max(region.w, region.h),
    Math.sqrt(HOLE_BUDGET / Math.max(1, region.holeArea)),
  );
  const w = Math.max(8, Math.round(region.w * scale)), h = Math.max(8, Math.round(region.h * scale));

  const small = document.createElement("canvas");
  small.width = w; small.height = h;
  const sctx = small.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(image, region.x, region.y, region.w, region.h, 0, 0, w, h);
  const pixels = sctx.getImageData(0, 0, w, h).data;

  const smallMask = document.createElement("canvas");
  smallMask.width = w; smallMask.height = h;
  const mctx = smallMask.getContext("2d", { willReadFrequently: true });
  mctx.drawImage(mask, region.x, region.y, region.w, region.h, 0, 0, w, h);
  const maskPixels = mctx.getImageData(0, 0, w, h).data;

  const base = levelFromImageData(pixels, w, h, maskPixels);
  let any = false;
  for (let i = 0; i < base.hole.length; i++) if (base.hole[i]) { any = true; break; }
  if (!any) return null;

  // Coarse to fine: the big structure gets decided on a tiny image, where the
  // search is cheap and a patch spans a lot of picture, and each finer level
  // only has to add detail to an answer that is already roughly right.
  const pyramid = [base];
  while (Math.min(pyramid[pyramid.length - 1].w, pyramid[pyramid.length - 1].h) > COARSEST) {
    pyramid.push(shrink(pyramid[pyramid.length - 1]));
  }

  const rng = seededRandom(12345);
  seedHole(pyramid[pyramid.length - 1]);
  for (let level = pyramid.length - 1; level >= 0; level--) {
    say(`Working it out… ${pyramid.length - level}/${pyramid.length}`);
    await breathe();                     // let the browser paint the message
    await solveLevel(pyramid[level], rng, breathe);
    if (level > 0) upsampleInto(pyramid[level], pyramid[level - 1]);
  }

  say("Putting it back…");
  await breathe();

  // The solved small image, as a canvas.
  const solved = sctx.createImageData(w, h);
  for (let i = 0, n = w * h; i < n; i++) {
    solved.data[i * 4] = clamp(base.rgb[i * 3], 0, 255);
    solved.data[i * 4 + 1] = clamp(base.rgb[i * 3 + 1], 0, 255);
    solved.data[i * 4 + 2] = clamp(base.rgb[i * 3 + 2], 0, 255);
    solved.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(solved, 0, 0);

  // Full size: the original, with the filled window painted over it through the
  // mask. Feathering the mask slightly hides the seam between real pixels and
  // invented ones. Everything outside the brush is untouched camera data.
  const out = document.createElement("canvas");
  out.width = iw; out.height = ih;
  const octx = out.getContext("2d");
  octx.drawImage(image, 0, 0);

  const patch = document.createElement("canvas");
  patch.width = region.w; patch.height = region.h;
  const pctx = patch.getContext("2d");
  pctx.drawImage(small, 0, 0, region.w, region.h);
  pctx.globalCompositeOperation = "destination-in";
  pctx.filter = `blur(${Math.max(1, Math.round(Math.max(region.w, region.h) / 200))}px)`;
  pctx.drawImage(mask, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
  pctx.filter = "none";

  octx.drawImage(patch, region.x, region.y);
  say("");
  return out;
}
