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
 * settled around each pixel, and copies it. Remove a tree and the gap fills
 * with the sky, hedge and grass the tree was standing in front of, taken from
 * wherever that material actually occurs in the frame.
 *
 * ---- why this used to blur, and what changed -------------------------------
 *
 * The first version solved the fill on a 512px thumbnail and then scaled the
 * invented pixels back up to the photo's real size. For a speck of dust that is
 * a 1x scale and looks perfect. For a tree it is an 8x bilinear enlargement of
 * the answer — and an 8x bilinear enlargement is, precisely, a blur. The patch
 * matching was never the problem; its output was being destroyed on the way
 * home.
 *
 * So the small solve no longer produces the pixels. It produces the map: for
 * every pixel of the hole, where in the photograph its material comes from.
 * A map is smooth and survives being scaled up. The pixels are then copied at
 * full resolution, straight out of the camera data, through that map. Grass
 * keeps the grain of grass because it is the same grass, at the same
 * resolution, from forty pixels to the left.
 *
 * It runs on the machine looking at it, costs nothing, and needs no network.
 * ------------------------------------------------------------------------ */

const PATCH = 7;                 // odd; the window matched against the rest of the photo
const HALF = (PATCH - 1) / 2;
const WORK = 640;                // longest edge of the window the map is solved in
const HOLE_BUDGET = 26000;       // most pixels the map will ever cover at once
const COARSEST = 32;             // stop making the pyramid smaller than this
const REFINE_PASSES = 4;         // coherence passes after the first sweep
const FINE_BUDGET = 12e6;        // most full-resolution pixels held at once

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
      let r = 0, g = 0, b = 0, known = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(level.w - 1, x * 2 + dx), sy = Math.min(level.h - 1, y * 2 + dy);
          const si = sy * level.w + sx;
          if (level.hole[si]) continue;
          r += level.rgb[si * 3]; g += level.rgb[si * 3 + 1]; b += level.rgb[si * 3 + 2];
          known++;
        }
      }
      const oi = y * w + x;
      out.hole[oi] = known === 0 ? 1 : 0;
      if (known) { out.rgb[oi * 3] = r / known; out.rgb[oi * 3 + 1] = g / known; out.rgb[oi * 3 + 2] = b / known; }
    }
  }
  return out;
}

// Push a solved coarse level up into the next finer one, but only inside the
// hole: everything outside is real photograph and must not be touched. The map
// goes up with it, doubled, so the finer level starts from an answer that is
// already roughly right instead of from nothing.
function upsampleInto(coarse, fine) {
  fine.hintX = new Int32Array(fine.w * fine.h).fill(-1);
  fine.hintY = new Int32Array(fine.w * fine.h);
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
      if (coarse.nnx && coarse.hole[ci] && coarse.nnx[ci] >= 0) {
        fine.hintX[fi] = coarse.nnx[ci] * 2 + (x & 1);
        fine.hintY[fi] = coarse.nny[ci] * 2 + (y & 1);
      }
    }
  }
}

// Something has to be in the hole before the first search, or every patch is
// matching against black.
//
// The obvious choice is the average of the rest of the picture, and it is a
// trap. In a landscape with a big pale sky that average is light grey, so the
// very first thing the search is asked to match is a grey smudge — and it
// dutifully goes and finds the road. The hole then fills with beautifully
// sharp, completely wrong material, which is worse than a blur because it looks
// deliberate.
//
// So the seed is grown inward from the hole's own edge instead: every pixel
// starts as the nearest real pixel to it. A gap in a cliff starts out looking
// like cliff, and the search is pointed at the right part of the photograph
// from the first pass.
function seedHole(level) {
  const { w, h, hole, rgb } = level;
  const n = w * h;
  const from = new Int32Array(n).fill(-1);
  const queue = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (hole[i]) continue;
      const touches = (x > 0 && hole[i - 1]) || (x < w - 1 && hole[i + 1])
        || (y > 0 && hole[i - w]) || (y < h - 1 && hole[i + w]);
      if (touches) { from[i] = i; queue.push(i); }
    }
  }

  for (let k = 0; k < queue.length; k++) {
    const i = queue[k], x = i % w, y = (i / w) | 0;
    const push = (j) => { if (hole[j] && from[j] < 0) { from[j] = from[i]; queue.push(j); } };
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }

  // A hole touching no real photograph at all has nothing to grow from; the
  // average is the only thing left to say about it.
  let ar = 0, ag = 0, ab = 0, known = 0;
  for (let i = 0; i < n; i++) {
    if (hole[i]) continue;
    ar += rgb[i * 3]; ag += rgb[i * 3 + 1]; ab += rgb[i * 3 + 2];
    known++;
  }
  if (known) { ar /= known; ag /= known; ab /= known; }

  for (let i = 0; i < n; i++) {
    if (!hole[i]) continue;
    const s = from[i];
    if (s >= 0) {
      rgb[i * 3] = rgb[s * 3]; rgb[i * 3 + 1] = rgb[s * 3 + 1]; rgb[i * 3 + 2] = rgb[s * 3 + 2];
    } else {
      rgb[i * 3] = ar; rgb[i * 3 + 1] = ag; rgb[i * 3 + 2] = ab;
    }
  }
}

// Luma slope, recomputed whenever the hole contents change. Matching on colour
// alone lets a patch sit happily across an edge so long as the average is
// right, which is how a horizon behind a removed tree ends up stepped. Matching
// the slope as well makes the edge carry on through the gap.
function computeGrad(level) {
  const { w, h, rgb } = level;
  if (!level.gx) { level.gx = new Float32Array(w * h); level.gy = new Float32Array(w * h); }
  const { gx, gy } = level;
  const lum = (j) => 0.299 * rgb[j * 3] + 0.587 * rgb[j * 3 + 1] + 0.114 * rgb[j * 3 + 2];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const xm = y * w + (x > 0 ? x - 1 : x), xp = y * w + (x < w - 1 ? x + 1 : x);
      const ym = (y > 0 ? y - 1 : y) * w + x, yp = (y < h - 1 ? y + 1 : y) * w + x;
      gx[i] = lum(xp) - lum(xm);
      gy[i] = lum(yp) - lum(ym);
    }
  }
}

/* ------------------------------- PatchMatch ------------------------------- */

// How badly a patch centred on the hole side matches one centred on the source
// side. Sum of squared differences, abandoned early once it cannot win.
//
// Real photograph inside the window counts for far more than the guess
// currently sitting in the hole. Without this the search compares its own
// invention against the world, finds that smooth matches smooth, and settles
// on a flat patch — the fill converges to the average of everything and the
// texture never comes back. Weighting the known pixels up means the boundary
// decides, and propagation carries that decision inward.
const W_REAL = 1;          // pixels that came out of the camera
const W_SETTLED = 0.35;    // pixels this run has already chosen and committed
const W_UNSET = 0.08;      // pixels still holding the seed colour
const GRAD_W = 0.6;        // how much the slope counts next to the colour

function patchCost(level, ax, ay, bx, by, best) {
  const { w, h, rgb, wt, gx, gy } = level;
  let sum = 0;
  for (let dy = -HALF; dy <= HALF; dy++) {
    const ay2 = clamp(ay + dy, 0, h - 1), by2 = clamp(by + dy, 0, h - 1);
    for (let dx = -HALF; dx <= HALF; dx++) {
      const ax2 = clamp(ax + dx, 0, w - 1), bx2 = clamp(bx + dx, 0, w - 1);
      const ap = ay2 * w + ax2, bp = by2 * w + bx2;
      const ai = ap * 3, bi = bp * 3;
      const dr = rgb[ai] - rgb[bi], dg = rgb[ai + 1] - rgb[bi + 1], db = rgb[ai + 2] - rgb[bi + 2];
      const ex = gx[ap] - gx[bp], ey = gy[ap] - gy[bp];
      sum += wt[ap] * (dr * dr + dg * dg + db * db + GRAD_W * (ex * ex + ey * ey));
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

// Work out the map for one level, boundary inward, then go back over it a few
// times for coherence.
//
// The first version of this iterated over the whole hole at once and averaged
// every patch that covered a pixel. That converges beautifully to the wrong
// thing: an average of a hundred patches of grass is the colour of grass, not
// grass. Texture is exactly the detail averaging destroys.
//
// So nothing is ever averaged. The first sweep goes outside in, each pixel
// chosen when its neighbours are already settled and taken outright from the
// single best-fitting patch. The refinement passes then let every pixel look
// again now that the whole hole has something in it — which is what turns a run
// of independently plausible choices into one continuous piece of hedge.
async function solveLevel(level, rng, yieldToPage) {
  const { w, h, hole } = level;
  const valid = buildValid(level);
  const order = bandOrder(level);
  if (!order.length) return;

  const sources = [];
  for (let i = 0, n = w * h; i < n; i++) if (valid[i]) sources.push(i);
  if (!sources.length) return;                 // the brush covered the whole frame

  // How much each pixel's opinion counts: real photograph, something this run
  // has settled, or the seed colour nobody has looked at yet.
  level.wt = new Float32Array(w * h);
  for (let i = 0, n = w * h; i < n; i++) level.wt[i] = hole[i] ? W_UNSET : W_REAL;

  const nnx = new Int32Array(w * h).fill(-1), nny = new Int32Array(w * h).fill(-1);
  level.nnx = nnx; level.nny = nny;
  const maxSearch = Math.max(w, h);
  computeGrad(level);

  let bestCost = Infinity, bx = -1, by = -1, tx = 0, ty = 0;

  const consider = (cx, cy) => {
    const sx = clamp(cx, HALF, w - 1 - HALF), sy = clamp(cy, HALF, h - 1 - HALF);
    if (!valid[sy * w + sx]) return;
    const c = patchCost(level, tx, ty, sx, sy, bestCost);
    if (c < bestCost) { bestCost = c; bx = sx; by = sy; }
  };

  const commit = (t) => {
    const si = (by * w + bx) * 3;
    level.rgb[t * 3] = level.rgb[si];
    level.rgb[t * 3 + 1] = level.rgb[si + 1];
    level.rgb[t * 3 + 2] = level.rgb[si + 2];
    nnx[t] = bx; nny[t] = by;
  };

  const neighbours = (t) => {
    if (tx > 0 && nnx[t - 1] >= 0) consider(nnx[t - 1] + 1, nny[t - 1]);
    if (tx < w - 1 && nnx[t + 1] >= 0) consider(nnx[t + 1] - 1, nny[t + 1]);
    if (ty > 0 && nnx[t - w] >= 0) consider(nnx[t - w], nny[t - w] + 1);
    if (ty < h - 1 && nnx[t + w] >= 0) consider(nnx[t + w], nny[t + w] - 1);
  };

  // ---- first sweep: outside in --------------------------------------------
  for (let k = 0; k < order.length; k++) {
    if (yieldToPage && (k & 1023) === 1023) await yieldToPage();
    const t = order[k];
    tx = t % w; ty = (t / w) | 0;
    bestCost = Infinity; bx = -1; by = -1;

    // Whatever the settled neighbours chose, shifted by one. This is the
    // propagation step, and it is what keeps a filled region coherent instead
    // of a mosaic of unrelated scraps.
    neighbours(t);

    // What the level below this one decided for the same spot.
    if (level.hintX && level.hintX[t] >= 0) consider(level.hintX[t], level.hintY[t]);

    // A handful of random guesses, coarse to fine, to find something better
    // than the neighbours knew about.
    if (bx < 0) {
      const pick = sources[(rng() * sources.length) | 0];
      consider(pick % w, (pick / w) | 0);
    }
    for (let radius = maxSearch; radius >= 1; radius >>= 1) {
      const ox = ((rng() * 2 - 1) * radius) | 0, oy = ((rng() * 2 - 1) * radius) | 0;
      consider((bx < 0 ? tx : bx) + ox, (by < 0 ? ty : by) + oy);
    }

    if (bx < 0) continue;
    commit(t);
    level.wt[t] = W_SETTLED;
  }

  // ---- refinement: look again, now that everything has something in it -----
  const passes = w * h > 4096 ? REFINE_PASSES : 2;
  for (let pass = 0; pass < passes; pass++) {
    computeGrad(level);
    const forward = (pass & 1) === 0;
    for (let k = 0; k < order.length; k++) {
      if (yieldToPage && (k & 1023) === 1023) await yieldToPage();
      const t = order[forward ? k : order.length - 1 - k];
      if (nnx[t] < 0) continue;
      tx = t % w; ty = (t / w) | 0;
      bx = nnx[t]; by = nny[t];
      bestCost = patchCost(level, tx, ty, bx, by, Infinity);

      neighbours(t);
      for (let radius = maxSearch; radius >= 1; radius >>= 1) {
        const ox = ((rng() * 2 - 1) * radius) | 0, oy = ((rng() * 2 - 1) * radius) | 0;
        consider(bx + ox, by + oy);
      }
      commit(t);
    }
  }
}

/* --------------------------------- the job -------------------------------- */

// Where the brush actually went, plus a collar of real photograph around it to
// copy from. The collar is the material the fill is allowed to use, so for a
// big object it wants to be generous — the sky and grass behind a tree are a
// long way from the tree. It costs nothing in sharpness any more: the collar
// sets how big the map is, and the map is not what you end up looking at.
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

  // The brush's own bounding box, which is all that ever has to be repainted.
  const hx = Math.max(0, Math.floor(x0)), hy = Math.max(0, Math.floor(y0));

  return {
    x: rx,
    y: ry,
    w: Math.min(iw, Math.ceil(x1 + pad)) - rx,
    h: Math.min(ih, Math.ceil(y1 + pad)) - ry,
    holeArea: painted / (s * s),          // in full-resolution pixels
    hx,
    hy,
    hw: Math.max(1, Math.min(iw, Math.ceil(x1)) - hx),
    hh: Math.max(1, Math.min(ih, Math.ceil(y1)) - hy),
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
 * The map is solved small, because patch matching is O(pixels x passes x patch)
 * and at full resolution it would take minutes in a browser tab. The pixels are
 * then copied at full resolution through that map, so what lands in the hole is
 * camera data at camera resolution rather than an enlargement of a thumbnail.
 * Everything outside the brush is left exactly as it was.
 */
export async function healRegion({ image, mask, onProgress }) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;

  const say = (m) => { if (onProgress) onProgress(m); };
  const breathe = () => new Promise((r) => setTimeout(r, 0));

  say("Reading the picture…");

  const region = maskBounds(mask, iw, ih);
  if (!region) return null;

  // Two caps on the map, whichever bites first: the window must fit in WORK,
  // and the hole itself must stay under HOLE_BUDGET pixels, because the cost is
  // driven by how many pixels have to be decided, not by how big the picture
  // is. These now only limit how finely the map is drawn — not how sharp the
  // result is, which is the whole point of the rewrite.
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
    say(`Working out what was behind it… ${pyramid.length - level}/${pyramid.length}`);
    await breathe();                     // let the browser paint the message
    await solveLevel(pyramid[level], rng, breathe);
    if (level > 0) upsampleInto(pyramid[level], pyramid[level - 1]);
  }

  say("Copying the real pixels in…");
  await breathe();

  return synthesize(image, mask, region, base, iw, ih);
}

/* ------------------------------ the seam ---------------------------------- */

// Copied material almost never sits at quite the right brightness. Grass taken
// from forty pixels left came from slightly different light, and a whole region
// of it lands a shade dark — which is why a fill can be perfectly textured and
// still read as a rectangle stuck on the picture. Nothing about the texture is
// wrong; the level is.
//
// So: look at every pixel where the fill meets real photograph, measure how far
// off it is there, fit a gentle tilted plane through those differences, and
// subtract it across the whole fill. A plane can only move the overall level and
// lean it one way — it has no way to touch detail, so the texture survives
// exactly as copied while the join disappears.
const SEAM_LIMIT = 48;           // never shift a channel further than this

function seamPlane(base) {
  const { w, h, hole, rgb } = base;
  // Normal equations for r = a + b*x + c*y, one set per channel.
  const S = new Float64Array(9);
  const t = [new Float64Array(3), new Float64Array(3), new Float64Array(3)];
  let count = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!hole[i]) continue;
      let sr = 0, sg = 0, sb = 0, c = 0;
      const look = (j) => {
        if (hole[j]) return;
        sr += rgb[j * 3] - rgb[i * 3];
        sg += rgb[j * 3 + 1] - rgb[i * 3 + 1];
        sb += rgb[j * 3 + 2] - rgb[i * 3 + 2];
        c++;
      };
      if (x > 0) look(i - 1);
      if (x < w - 1) look(i + 1);
      if (y > 0) look(i - w);
      if (y < h - 1) look(i + w);
      if (!c) continue;

      const v = [1, x, y];
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) S[a * 3 + b] += v[a] * v[b];
        t[0][a] += v[a] * (sr / c);
        t[1][a] += v[a] * (sg / c);
        t[2][a] += v[a] * (sb / c);
      }
      count++;
    }
  }
  if (count < 12) return null;   // too little edge to fit anything trustworthy

  const solve = (rhs) => {
    // Gauss-Jordan on a 3x3, with a nudge on the diagonal so a degenerate edge
    // (a perfectly straight seam, say) falls back to a flat offset instead of
    // blowing up.
    const m = [
      [S[0] + 1e-6, S[1], S[2], rhs[0]],
      [S[3], S[4] + 1e-6, S[5], rhs[1]],
      [S[6], S[7], S[8] + 1e-6, rhs[2]],
    ];
    for (let col = 0; col < 3; col++) {
      let piv = col;
      for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
      if (Math.abs(m[piv][col]) < 1e-9) return null;
      const tmp = m[col]; m[col] = m[piv]; m[piv] = tmp;
      const d = m[col][col];
      for (let j = col; j < 4; j++) m[col][j] /= d;
      for (let r = 0; r < 3; r++) {
        if (r === col) continue;
        const f = m[r][col];
        if (!f) continue;
        for (let j = col; j < 4; j++) m[r][j] -= f * m[col][j];
      }
    }
    return [m[0][3], m[1][3], m[2][3]];
  };

  const plane = [solve(t[0]), solve(t[1]), solve(t[2])];
  if (plane.some((p) => !p || p.some((v) => !Number.isFinite(v)))) return null;
  return plane;
}

// A plane gets the overall level right and cannot do any more than that. Where
// the join runs through something that is itself changing -- a sky going pale
// towards the horizon, mist thinning across the frame -- the true correction is
// not a plane, and what is left over shows up as a hard straight edge exactly
// along the line where the fill starts.
//
// So the leftover is diffused instead. Every pixel on the join knows how far out
// it still is once the plane has had its say; that figure is held fixed there
// and averaged inward over the rest of the hole until it dies away. It is the
// membrane a soap film makes across a bent wire, and it is the classic way of
// hiding a seam: smooth everywhere inside, exactly right at the edge.
//
// Solving it needs no accuracy in the usual sense. The answer is smooth by
// definition, so a few hundred passes of averaging at the map's resolution --
// starting from the plane, which has already taken out the part that carries
// furthest -- lands close enough that nothing is visible.
const SEAM_PASSES = 320;

function seamField(base, plane) {
  const { w, h, hole, rgb } = base;
  const n = w * h;
  const at = (p, x, y) => (plane ? p[0] + p[1] * x + p[2] * y : 0);

  let cur = new Float32Array(n * 3);
  const fixed = new Uint8Array(n);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!hole[i]) continue;
      let sr = 0, sg = 0, sb = 0, c = 0;
      const look = (j) => {
        if (hole[j]) return;
        sr += rgb[j * 3] - rgb[i * 3];
        sg += rgb[j * 3 + 1] - rgb[i * 3 + 1];
        sb += rgb[j * 3 + 2] - rgb[i * 3 + 2];
        c++;
      };
      if (x > 0) look(i - 1);
      if (x < w - 1) look(i + 1);
      if (y > 0) look(i - w);
      if (y < h - 1) look(i + w);
      if (!c) continue;
      // What the plane did not already account for.
      cur[i * 3] = sr / c - at(plane ? plane[0] : null, x, y);
      cur[i * 3 + 1] = sg / c - at(plane ? plane[1] : null, x, y);
      cur[i * 3 + 2] = sb / c - at(plane ? plane[2] : null, x, y);
      fixed[i] = 1;
    }
  }

  // Only the inside of the hole ever changes. Walking the whole frame 320 times
  // over, and copying the whole field each time, costs several hundred million
  // operations for a few thousand pixels of answer — so the pixels that move
  // are listed once and only they are touched. Everything else is identical in
  // both buffers, so it needs copying once rather than every pass.
  const loose = [];
  for (let i = 0; i < n; i++) if (hole[i] && !fixed[i]) loose.push(i);

  let next = new Float32Array(n * 3);
  next.set(cur);
  if (loose.length) {
    for (let pass = 0; pass < SEAM_PASSES; pass++) {
      for (let k = 0; k < loose.length; k++) {
        const i = loose[k], x = i % w, y = (i / w) | 0;
        let r = 0, g = 0, b = 0, c = 0;
        if (x > 0 && hole[i - 1]) { const j = i - 1; r += cur[j * 3]; g += cur[j * 3 + 1]; b += cur[j * 3 + 2]; c++; }
        if (x < w - 1 && hole[i + 1]) { const j = i + 1; r += cur[j * 3]; g += cur[j * 3 + 1]; b += cur[j * 3 + 2]; c++; }
        if (y > 0 && hole[i - w]) { const j = i - w; r += cur[j * 3]; g += cur[j * 3 + 1]; b += cur[j * 3 + 2]; c++; }
        if (y < h - 1 && hole[i + w]) { const j = i + w; r += cur[j * 3]; g += cur[j * 3 + 1]; b += cur[j * 3 + 2]; c++; }
        if (!c) continue;
        next[i * 3] = r / c; next[i * 3 + 1] = g / c; next[i * 3 + 2] = b / c;
      }
      const swap = cur; cur = next; next = swap;
    }
  }

  // One ring outside the hole carries its neighbour's value, so reading the
  // field smoothly at full resolution does not fade it away right at the join,
  // which is the one place it has to be exactly right.
  const out = cur;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (hole[i]) continue;
      let r = 0, g = 0, b = 0, c = 0;
      const take = (j) => {
        if (!hole[j]) return;
        r += out[j * 3]; g += out[j * 3 + 1]; b += out[j * 3 + 2]; c++;
      };
      if (x > 0) take(i - 1);
      if (x < w - 1) take(i + 1);
      if (y > 0) take(i - w);
      if (y < h - 1) take(i + w);
      if (c) { out[i * 3] = r / c; out[i * 3 + 1] = g / c; out[i * 3 + 2] = b / c; }
    }
  }
  return out;
}

/* ---------------------------- the full-size copy --------------------------- */

// The map says, for each pixel of the hole, which part of the photograph its
// material comes from. Here that is turned back into pixels — at the photo's
// own resolution, by copying, never by enlarging.
//
// The map is read as an offset rather than as a destination. "This came from
// 180 pixels left and 40 up" scales cleanly to any resolution; "this came from
// pixel (212, 88) of the thumbnail" does not.
function synthesize(image, mask, region, base, iw, ih) {
  const { w, h, nnx, hole, rgb } = base;
  const nny = base.nny;

  // How much of the region we can afford to hold at once. On a normal photo
  // this is 1 and the copy is literally camera pixels; on a very large one it
  // steps down, and even then it is a long way above the old 512px solve.
  const fine = Math.min(1, Math.sqrt(FINE_BUDGET / Math.max(1, region.w * region.h)));
  const rw = Math.max(1, Math.round(region.w * fine)), rh = Math.max(1, Math.round(region.h * fine));
  const k = rw / w;                       // fine pixels per map pixel

  // How far off the level is where the fill meets the photograph: the plane for
  // the part that carries right across, the membrane for everything left over.
  // Both are smooth, so they can be read at full resolution without softening
  // anything — which is the whole reason the correction is done this way round
  // rather than by blurring the join.
  const plane = seamPlane(base);
  const field = seamField(base, plane);

  const shift = (ch, mxf, myf) => {
    const p = plane ? plane[ch] : null;
    const flat = p ? p[0] + p[1] * mxf + p[2] * myf : 0;

    const x0 = Math.floor(mxf), y0 = Math.floor(myf);
    const fx = mxf - x0, fy = myf - y0;
    const ax = clamp(x0, 0, w - 1), bx = clamp(x0 + 1, 0, w - 1);
    const ay = clamp(y0, 0, h - 1), by = clamp(y0 + 1, 0, h - 1);
    const g = (xx, yy) => field[(yy * w + xx) * 3 + ch];
    const local = g(ax, ay) * (1 - fx) * (1 - fy) + g(bx, ay) * fx * (1 - fy)
      + g(ax, by) * (1 - fx) * fy + g(bx, by) * fx * fy;

    return clamp(flat + local, -SEAM_LIMIT, SEAM_LIMIT);
  };

  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = rw; srcCanvas.height = rh;
  const srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true });
  srcCtx.drawImage(image, region.x, region.y, region.w, region.h, 0, 0, rw, rh);
  const src = srcCtx.getImageData(0, 0, rw, rh).data;

  // The mask at the same scale, alpha only — a patch may never take its
  // material from inside the thing being removed. Kept as one byte a pixel so
  // the four-byte copy can be let go of straight away.
  const masked = new Uint8Array(rw * rh);
  {
    const mkCanvas = document.createElement("canvas");
    mkCanvas.width = rw; mkCanvas.height = rh;
    const mkCtx = mkCanvas.getContext("2d", { willReadFrequently: true });
    mkCtx.drawImage(mask, region.x, region.y, region.w, region.h, 0, 0, rw, rh);
    const mkData = mkCtx.getImageData(0, 0, rw, rh).data;
    for (let i = 0, n = rw * rh; i < n; i++) masked[i] = mkData[i * 4 + 3] > 24 ? 1 : 0;
  }

  // Only the brush's own bounding box has to be repainted, with a small collar
  // so the feather has something to bite on.
  const margin = Math.ceil(k) + 4;
  const fx0 = clamp(Math.floor((region.hx - region.x) * fine) - margin, 0, rw - 1);
  const fy0 = clamp(Math.floor((region.hy - region.y) * fine) - margin, 0, rh - 1);
  const fx1 = clamp(Math.ceil((region.hx + region.hw - region.x) * fine) + margin, fx0 + 1, rw);
  const fy1 = clamp(Math.ceil((region.hy + region.hh - region.y) * fine) + margin, fy0 + 1, rh);
  const pw = fx1 - fx0, ph = fy1 - fy0;

  const patch = document.createElement("canvas");
  patch.width = pw; patch.height = ph;
  const pctx = patch.getContext("2d");
  const outImg = pctx.createImageData(pw, ph);
  const out = outImg.data;

  // Fall back to the map's own colour — only reachable where the brush covers
  // something the map could not find any material for at all.
  const fallback = (o, mi, dr, dg, db) => {
    out[o] = clamp(rgb[mi * 3] + dr, 0, 255);
    out[o + 1] = clamp(rgb[mi * 3 + 1] + dg, 0, 255);
    out[o + 2] = clamp(rgb[mi * 3 + 2] + db, 0, 255);
    out[o + 3] = 255;
  };

  for (let Y = fy0; Y < fy1; Y++) {
    for (let X = fx0; X < fx1; X++) {
      const o = ((Y - fy0) * pw + (X - fx0)) * 4;
      const fi = Y * rw + X;

      // Outside the brush: the photograph, untouched. It is masked away in a
      // moment anyway, but it makes the feather blend into the right colour.
      if (!masked[fi]) {
        out[o] = src[fi * 4]; out[o + 1] = src[fi * 4 + 1]; out[o + 2] = src[fi * 4 + 2]; out[o + 3] = 255;
        continue;
      }

      // Which map pixel covers this one, and where it says to look.
      const mxf = (X + 0.5) / k - 0.5, myf = (Y + 0.5) / k - 0.5;
      const mx = clamp(Math.round(mxf), 0, w - 1);
      const my = clamp(Math.round(myf), 0, h - 1);
      let mi = my * w + mx;

      // The level correction for this spot. Smooth by construction, so it can
      // be evaluated at full resolution without softening anything.
      const dr = shift(0, mxf, myf), dg = shift(1, mxf, myf), db = shift(2, mxf, myf);

      // The brush's edge is softer at full size than on the map, so a pixel can
      // be hole here while its map pixel is not. Borrow the nearest one that is.
      if (!hole[mi] || nnx[mi] < 0) {
        let found = -1;
        for (let r = 1; r <= 3 && found < 0; r++) {
          for (let dy = -r; dy <= r && found < 0; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              const nx = clamp(mx + dx, 0, w - 1), ny = clamp(my + dy, 0, h - 1);
              const ni = ny * w + nx;
              if (hole[ni] && nnx[ni] >= 0) { found = ni; break; }
            }
          }
        }
        if (found < 0) { fallback(o, mi, dr, dg, db); continue; }
        mi = found;
      }

      const ox = (nnx[mi] - (mi % w)) * k;
      const oy = (nny[mi] - ((mi / w) | 0)) * k;
      let SX = clamp(Math.round(X + ox), 0, rw - 1);
      let SY = clamp(Math.round(Y + oy), 0, rh - 1);

      // The map was solved with a patch margin, so this should never land
      // inside the thing being removed — but if a soft edge lets it, walk on
      // along the same offset until it is out.
      if (masked[SY * rw + SX]) {
        let ok = false;
        for (let step = 1; step <= 8; step++) {
          const t = 1 + step * 0.25;
          const tX = clamp(Math.round(X + ox * t), 0, rw - 1);
          const tY = clamp(Math.round(Y + oy * t), 0, rh - 1);
          if (!masked[tY * rw + tX]) { SX = tX; SY = tY; ok = true; break; }
        }
        if (!ok) { fallback(o, mi, dr, dg, db); continue; }
      }

      const si = (SY * rw + SX) * 4;
      out[o] = clamp(src[si] + dr, 0, 255);
      out[o + 1] = clamp(src[si + 1] + dg, 0, 255);
      out[o + 2] = clamp(src[si + 2] + db, 0, 255);
      out[o + 3] = 255;
    }
  }
  pctx.putImageData(outImg, 0, 0);

  // Mask it back to the brush, with a hairline feather. The fill is real detail
  // now, so this wants to be small — the old version needed a wide soft edge to
  // disguise a blurred patch, and a wide soft edge is its own kind of smear.
  const dx = region.x + fx0 / fine, dy = region.y + fy0 / fine;
  const dw = pw / fine, dh = ph / fine;

  const cut = document.createElement("canvas");
  cut.width = pw; cut.height = ph;
  const cctx = cut.getContext("2d");
  cctx.drawImage(patch, 0, 0);
  cctx.globalCompositeOperation = "destination-in";
  cctx.filter = `blur(${clamp(Math.round(Math.max(pw, ph) / 400), 1, 3)}px)`;
  cctx.drawImage(mask, dx, dy, dw, dh, 0, 0, pw, ph);
  cctx.filter = "none";

  const outCanvas = document.createElement("canvas");
  outCanvas.width = iw; outCanvas.height = ih;
  const octx = outCanvas.getContext("2d");
  octx.drawImage(image, 0, 0);
  octx.drawImage(cut, dx, dy, dw, dh);
  return outCanvas;
}
