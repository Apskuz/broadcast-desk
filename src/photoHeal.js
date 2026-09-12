/* --------------------------------------------------------------------------
 * Content-aware fill.
 *
 * Adobe's version sends the photo to Firefly and gets back pixels a model
 * invented. We cannot do that here — there is no model to call, and calling one
 * would cost money per picture. So this is the other thing, the one that ran
 * inside Photoshop for a decade before Firefly existed, and it is assembled
 * here out of four papers that each fix what the one before it got wrong.
 *
 *   PatchMatch (Barnes et al., 2009) is the engine: a randomised way of
 *   finding, for every patch of the hole, the patch of the rest of the
 *   photograph that fits it best. Guesses propagate to their neighbours, and a
 *   random search at exponentially shrinking radius shakes them out of local
 *   minima. Four or five passes and it has essentially converged.
 *
 *   Image completion (Wexler/Simakov, as used in PatchMatch §4) wraps that in
 *   expectation-maximisation over a pyramid: find the matches, let every patch
 *   covering a pixel vote on its colour, average the votes, repeat. That is
 *   what makes a fill coherent rather than a mosaic of unrelated scraps.
 *
 *   But averaging votes is precisely what blurs. Image Melding (Darabi et al.,
 *   2012) is the answer: vote on the *gradients* as well as the colours, and
 *   rebuild the pixels by solving a screened Poisson equation over the two.
 *   Averaged colours lose texture; averaged gradients keep it, because a
 *   gradient says "there is an edge here this strong" and that survives being
 *   averaged with its neighbours in a way that a colour does not. Coherence and
 *   sharpness at the same time, instead of one bought with the other.
 *
 *   Generalized PatchMatch (Barnes et al., 2010) widens the search from
 *   translations to scales, rotations and reflections, so a patch of hedge can
 *   be reused slightly larger, turned, or mirrored. It multiplies the amount of
 *   the photograph that can be brought to bear on the hole.
 *
 *   And Guided PatchMatch (2022) is how this runs on a 4000px photograph at
 *   all: complete it small, then carry the answer up and *refine it again* at
 *   the real resolution rather than merely enlarging it. The last stage copies
 *   camera pixels, so the fill ends up made of photograph rather than of an
 *   enlargement of a thumbnail.
 *
 * It invents nothing: everything in the hole was somewhere else in the same
 * frame. That makes it very good at a bin, a sign, a wire, a passer-by, and
 * bad at anything needing an object that is not in the picture at all.
 *
 * It runs on the machine looking at it, costs nothing, and needs no network.
 * ------------------------------------------------------------------------ */

const PATCH = 7;
const HALF = (PATCH - 1) / 2;

const WORK = 640;            // longest edge the pyramid is solved on
const HOLE_BUDGET = 26000;   // most pixels the pyramid will ever synthesise
const COARSEST = 32;
const MID_BUDGET = 2e6;      // pixels for the high-resolution refinement pass
const FINE_BUDGET = 12e6;    // pixels held for the final copy

const REFINE_MIN = 2, REFINE_MAX = 4;  // look-again passes per pyramid level
const MID_ITERS = 1;               // look-again passes at the refinement size
const MID_RADIUS = 24;             // how far the close-up search may roam


// How far the search may stray from a plain copy. Rotation is kept modest on
// purpose: a little helps organic texture find a fit, a lot tilts horizons.
const MIRROR = true;
const SCALE_LO = 0.85, SCALE_HI = 1.18;
const ROT_MAX = 0.22;              // radians, about 12 degrees

const W_REAL = 1;                  // a pixel that came out of the camera
const W_GUESS = 0.5;               // one this run is still deciding
const GRAD_W = 0.5;                // slope against colour, in the match cost

/* ------------------------------- small helpers ---------------------------- */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

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

// Something has to be in the hole before the first search, or every patch is
// matching against black.
//
// The obvious choice is the average of the rest of the picture, and it is a
// trap. In a landscape with a big pale sky that average is light grey, so the
// very first thing the search is asked to match is a grey smudge — and it
// dutifully goes and finds the road. The hole then fills with beautifully
// sharp, completely wrong material, which is worse than a blur because it looks
// deliberate. So the seed grows inward from the hole's own edge instead: every
// pixel starts as the nearest real pixel to it, and a gap in a cliff starts out
// looking like cliff.
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

// Put a network's guess into the hole as the starting point, instead of growing
// a colour in from the edge.
//
// The guess is soft — it was made at 512px and stretched back up — and none of
// that softness survives, because nothing here is ever shown. Its whole job is
// to tell the matcher roughly what belongs where, so that the first pass hunts
// for grass where grass should be and for fence where fence should be, instead
// of working that out from the boundary alone and sometimes getting it wrong.
// Outside the hole nothing is touched: that is real photograph and it stays.
function seedFromGuide(level, guide) {
  const { w, h, hole, rgb } = level;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(guide, 0, 0, guide.width, guide.height, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  for (let i = 0, n = w * h; i < n; i++) {
    if (!hole[i]) continue;
    rgb[i * 3] = px[i * 4];
    rgb[i * 3 + 1] = px[i * 4 + 1];
    rgb[i * 3 + 2] = px[i * 4 + 2];
  }
}

// How far every pixel is from the nearest hole pixel. A patch may only be taken
// from far enough out that nothing it covers is hole — otherwise the fill feeds
// on itself and smears. With rotation and scale in play the footprint is no
// longer axis-aligned, so a distance is the honest way to ask the question.
function holeDistance(level) {
  const { w, h, hole } = level;
  const n = w * h;
  const dist = new Int32Array(n).fill(-1);
  const queue = [];
  for (let i = 0; i < n; i++) if (hole[i]) { dist[i] = 0; queue.push(i); }
  for (let k = 0; k < queue.length; k++) {
    const i = queue[k], x = i % w, y = (i / w) | 0;
    const push = (j) => { if (dist[j] < 0) { dist[j] = dist[i] + 1; queue.push(j); } };
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  for (let i = 0; i < n; i++) if (dist[i] < 0) dist[i] = 1 << 20;
  return dist;
}

// Forward differences of luma, for the match cost. Matching on colour alone
// lets a patch sit happily across an edge so long as the average is right,
// which is how a horizon behind a removed tree ends up stepped.
function computeLuma(level) {
  const { w, h, rgb } = level;
  const n = w * h;
  if (!level.lum) { level.lum = new Float32Array(n); level.lgx = new Float32Array(n); level.lgy = new Float32Array(n); }
  const { lum, lgx, lgy } = level;
  for (let i = 0; i < n; i++) lum[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      lgx[i] = lum[x < w - 1 ? i + 1 : i] - lum[i];
      lgy[i] = lum[y < h - 1 ? i + w : i] - lum[i];
    }
  }
}

// Bilinear read, clamped at the edges.
function sample3(rgb, w, h, x, y, out) {
  const fx = clamp(x, 0, w - 1.001), fy = clamp(y, 0, h - 1.001);
  const x0 = fx | 0, y0 = fy | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
  const ax = fx - x0, ay = fy - y0;
  const i00 = (y0 * w + x0) * 3, i10 = (y0 * w + x1) * 3;
  const i01 = (y1 * w + x0) * 3, i11 = (y1 * w + x1) * 3;
  const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
  out[0] = rgb[i00] * w00 + rgb[i10] * w10 + rgb[i01] * w01 + rgb[i11] * w11;
  out[1] = rgb[i00 + 1] * w00 + rgb[i10 + 1] * w10 + rgb[i01 + 1] * w01 + rgb[i11 + 1] * w11;
  out[2] = rgb[i00 + 2] * w00 + rgb[i10 + 2] * w10 + rgb[i01 + 2] * w01 + rgb[i11 + 2] * w11;
}

function sample1(a, w, h, x, y) {
  const fx = clamp(x, 0, w - 1.001), fy = clamp(y, 0, h - 1.001);
  const x0 = fx | 0, y0 = fy | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
  const ax = fx - x0, ay = fy - y0;
  return a[y0 * w + x0] * (1 - ax) * (1 - ay) + a[y0 * w + x1] * ax * (1 - ay)
    + a[y1 * w + x0] * (1 - ax) * ay + a[y1 * w + x1] * ax * ay;
}

/* ------------------------------- PatchMatch ------------------------------- */

// The transform a match carries: mirror, then rotate, then scale. Stored per
// pixel as the four numbers that make it up rather than as a matrix, because
// the random search has to contract each of them independently.
function transformOf(level, i) {
  const m = level.nnM[i] ? -1 : 1;
  const a = level.nnA[i], s = level.nnS[i];
  const c = Math.cos(a) * s, sn = Math.sin(a) * s;
  // [ c -sn ] [ m 0 ]
  // [ sn  c ] [ 0 1 ]
  return { xx: c * m, xy: -sn, yx: sn * m, yy: c };
}

// Distance between the patch of the current estimate centred at (ax, ay) and
// the transformed patch of real photograph centred at (bx, by).
//
// Real photograph inside the window counts for more than the estimate. Without
// that the search compares its own guess against the world, finds that smooth
// matches smooth, and settles on a flat patch.
const PX = [0, 0, 0];

function patchDist(level, ax, ay, bx, by, t, cutoff) {
  const { w, h, rgb, hole, lgx, lgy } = level;
  const px = PX;
  let sum = 0;

  // Most matches are a plain copy, and a plain copy lands exactly on pixels.
  // Taking that path without the interpolation is worth about four times the
  // speed, which is the difference between this being usable and not.
  if (t.xy === 0 && t.yx === 0 && t.xx === 1 && t.yy === 1) {
    for (let dy = -HALF; dy <= HALF; dy++) {
      const ay2 = clamp(ay + dy, 0, h - 1), by2 = clamp(by + dy, 0, h - 1);
      for (let dx = -HALF; dx <= HALF; dx++) {
        const ax2 = clamp(ax + dx, 0, w - 1), bx2 = clamp(bx + dx, 0, w - 1);
        const ai = ay2 * w + ax2, bi = by2 * w + bx2;
        const dr = rgb[ai * 3] - rgb[bi * 3];
        const dg = rgb[ai * 3 + 1] - rgb[bi * 3 + 1];
        const db = rgb[ai * 3 + 2] - rgb[bi * 3 + 2];
        const ex = lgx[ai] - lgx[bi], ey = lgy[ai] - lgy[bi];
        const wt = level.wt ? level.wt[ai] : (hole[ai] ? W_GUESS : W_REAL);
        sum += wt * (dr * dr + dg * dg + db * db + GRAD_W * (ex * ex + ey * ey));
        if (sum >= cutoff) return sum;
      }
    }
    return sum;
  }

  for (let dy = -HALF; dy <= HALF; dy++) {
    for (let dx = -HALF; dx <= HALF; dx++) {
      const ax2 = clamp(ax + dx, 0, w - 1), ay2 = clamp(ay + dy, 0, h - 1);
      const ai = ay2 * w + ax2;

      const ux = bx + t.xx * dx + t.xy * dy;
      const uy = by + t.yx * dx + t.yy * dy;

      sample3(rgb, w, h, ux, uy, px);
      const dr = rgb[ai * 3] - px[0], dg = rgb[ai * 3 + 1] - px[1], db = rgb[ai * 3 + 2] - px[2];

      // The slope has to be compared in the same frame, so the source slope is
      // brought back through the transform before it is subtracted.
      const sgx = sample1(lgx, w, h, ux, uy), sgy = sample1(lgy, w, h, ux, uy);
      const tgx = t.xx * sgx + t.yx * sgy;
      const tgy = t.xy * sgx + t.yy * sgy;
      const ex = lgx[ai] - tgx, ey = lgy[ai] - tgy;

      const wt = level.wt ? level.wt[ai] : (hole[ai] ? W_GUESS : W_REAL);
      sum += wt * (dr * dr + dg * dg + db * db + GRAD_W * (ex * ex + ey * ey));
      if (sum >= cutoff) return sum;
    }
  }
  return sum;
}

/* ------------------------- the pass that keeps texture --------------------- */

// Voting and averaging is what makes a fill coherent, and it is also what makes
// it soft: an average of a hundred patches of grass is the colour of grass, not
// grass. Measured against the previous version it cost more than half the
// detail. So the pyramid uses it to decide the structure, and then the last and
// finest pass throws averaging away entirely.
//
// This is the other classic: onion-peel. Work inward from the edge of the hole,
// choose each pixel when its neighbours are already settled, and copy it
// outright from the single best-fitting patch — never a blend of several. What
// is already settled counts for something in the cost, but much less than real
// photograph, and what has not been reached yet counts for almost nothing, so
// the decision is driven by the picture rather than by the fill's own guesses.
const W_SETTLED = 0.35;
const W_UNSET = 0.08;
// What the hole is worth when a network has already said what belongs there.
// Much more than a colour grown in from the edge, which carries no information
// at all past the first few pixels, and still well short of real photograph.
const W_GUIDED = 0.35;

async function onionCopy(level, order, rng, sources, minDist, maxRadius, yieldToPage, refinePasses) {
  const { w, h, hole, rgb, nnx, nny, nnD, lum, lgx, lgy } = level;
  const n = w * h;

  // Whatever the coarse solve worked out is kept as a suggestion, not as
  // evidence — it tells the search where to look without dragging the answer
  // towards its own smoothness.
  const hintX = Int32Array.from(nnx), hintY = Int32Array.from(nny);
  const hintA = Float32Array.from(level.nnA), hintS = Float32Array.from(level.nnS);
  const hintM = Uint8Array.from(level.nnM);
  const hasHint = new Uint8Array(n);
  for (let i = 0; i < n; i++) hasHint[i] = nnD[i] < Infinity ? 1 : 0;

  level.wt = new Float32Array(n);
  const unset = level.guided ? W_GUIDED : W_UNSET;
  for (let i = 0; i < n; i++) level.wt[i] = hole[i] ? unset : W_REAL;
  for (let i = 0; i < n; i++) if (hole[i]) nnD[i] = Infinity;

  // Keep the slope arrays honest as pixels land, or every decision after the
  // first is matched against a picture that no longer exists.
  const touch = (i) => {
    const x = i % w, y = (i / w) | 0;
    lum[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
    const fix = (j) => {
      const jx = j % w, jy = (j / w) | 0;
      lgx[j] = lum[jx < w - 1 ? j + 1 : j] - lum[j];
      lgy[j] = lum[jy < h - 1 ? j + w : j] - lum[j];
    };
    fix(i);
    if (x > 0) fix(i - 1);
    if (y > 0) fix(i - w);
  };

  const run = (forward, first) => {
    for (let k = 0; k < order.length; k++) {
      const i = order[forward ? k : order.length - 1 - k];
      const x = i % w, y = (i / w) | 0;
      let bD = nnD[i], bx = nnx[i], by = nny[i], bA = level.nnA[i], bS = level.nnS[i], bM = level.nnM[i];

      const consider = (cx, cy, ca, cs, cm) => {
        const s = clamp(cs, SCALE_LO, SCALE_HI);
        const a = clamp(ca, -ROT_MAX, ROT_MAX);
        if (cx < 0 || cy < 0 || cx > w - 1 || cy > h - 1) return;
        const reach = Math.ceil(HALF * Math.max(1, s) * 1.45) + 1;
        if (minDist[(cy | 0) * w + (cx | 0)] <= reach) return;
        const m = cm ? -1 : 1;
        const c = Math.cos(a) * s, sn = Math.sin(a) * s;
        const t = { xx: c * m, xy: -sn, yx: sn * m, yy: c };
        const d = patchDist(level, x, y, cx, cy, t, bD);
        if (d < bD) { bD = d; bx = cx; by = cy; bA = a; bS = s; bM = cm; }
      };

      const step = forward ? -1 : 1;
      if (x + step >= 0 && x + step < w && nnD[i + step] < Infinity) {
        const j = i + step;
        consider(nnx[j] - step, nny[j], level.nnA[j], level.nnS[j], level.nnM[j]);
      }
      if (y + step >= 0 && y + step < h && nnD[i + step * w] < Infinity) {
        const j = i + step * w;
        consider(nnx[j], nny[j] - step, level.nnA[j], level.nnS[j], level.nnM[j]);
      }
      if (first && hasHint[i]) consider(hintX[i], hintY[i], hintA[i], hintS[i], hintM[i]);

      if (bD === Infinity && sources.length) {
        const pick = sources[(rng() * sources.length) | 0];
        consider(pick % w, (pick / w) | 0, 0, 1, 0);
      }
      // Every other guess is a plain copy — not turned, not resized.
      //
      // The search used to perturb the angle on every single sample, which had
      // two costs. A turned patch lands between pixels and has to interpolate,
      // about four times the work of a straight lookup, so essentially nothing
      // ever took the fast path. And it biased the whole search away from
      // simply copying, which is exactly what a course of bricks or a window
      // frame wants — turning those by a couple of degrees is what puts a kink
      // in them. Alternating costs nothing in reach, because a plain copy is
      // just the middle of the range the other samples cover anyway.
      let radius = Math.min(maxRadius || Math.max(w, h), Math.max(w, h)), frac = 1, turn = false;
      while (radius >= 1) {
        const ox = ((rng() * 2 - 1) * radius) | 0, oy = ((rng() * 2 - 1) * radius) | 0;
        const cx = (bD === Infinity ? x : bx) + ox, cy = (bD === Infinity ? y : by) + oy;
        if (turn) {
          const oa = (rng() * 2 - 1) * ROT_MAX * frac;
          const os = 1 + (rng() * 2 - 1) * (SCALE_HI - 1) * frac;
          const om = MIRROR && rng() < 0.12 ? (bM ? 0 : 1) : bM;
          consider(cx, cy, bA + oa, bS * os, om);
        } else {
          consider(cx, cy, 0, 1, 0);
        }
        turn = !turn;
        radius >>= 1; frac *= 0.5;
      }

      if (bD === Infinity) continue;
      const s = by * w + bx;
      rgb[i * 3] = rgb[s * 3]; rgb[i * 3 + 1] = rgb[s * 3 + 1]; rgb[i * 3 + 2] = rgb[s * 3 + 2];
      nnx[i] = bx; nny[i] = by; level.nnA[i] = bA; level.nnS[i] = bS; level.nnM[i] = bM; nnD[i] = bD;
      level.wt[i] = W_SETTLED;
      touch(i);
    }
  };

  run(true, true);
  if (yieldToPage) await yieldToPage();
  for (let p = 0; p < refinePasses; p++) {
    // Everything has something in it now, so every pixel may look again with
    // its neighbours' answers to go on. Costs are restated first: a stale one
    // blocks every improvement.
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      if (nnD[i] < Infinity) {
        nnD[i] = patchDist(level, i % w, (i / w) | 0, nnx[i], nny[i], transformOf(level, i), Infinity);
      }
    }
    run(p % 2 === 0, false);
    if (yieldToPage) await yieldToPage();
  }
}

// The order to work in: every pixel touching real photograph first, then every
// pixel touching those, and so on inward.
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
  for (let i = 0, n = w * h; i < n; i++) if (hole[i] && dist[i] < 0) queue.push(i);
  return queue;
}

function initNNF(level) {
  const n = level.w * level.h;
  level.nnx = new Int32Array(n);
  level.nny = new Int32Array(n);
  level.nnA = new Float32Array(n);
  level.nnS = new Float32Array(n).fill(1);
  level.nnM = new Uint8Array(n);
  level.nnD = new Float32Array(n).fill(Infinity);
}

// Expectation-maximisation on one level: match, vote, rebuild, repeat.
async function solveLevel(level, rng, yieldToPage, rounds) {
  const order = bandOrder(level);
  if (!order.length) return;

  const minDist = holeDistance(level);
  const sources = [];
  for (let i = 0, n = level.w * level.h; i < n; i++) {
    if (minDist[i] > HALF * SCALE_HI * 1.45 + 1) sources.push(i);
  }
  if (!sources.length) return;             // the brush covered the whole frame

  if (!level.nnD) initNNF(level);
  computeLuma(level);
  await onionCopy(level, order, rng, sources, minDist, 0, yieldToPage, rounds);
}

// Carry a solved level up into the next finer one: the pixels, and the match
// field with it, doubled — so the finer level starts from an answer that is
// already roughly right rather than from nothing.
function upsampleInto(coarse, fine) {
  initNNF(fine);
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
      if (coarse.nnD && coarse.nnD[ci] < Infinity) {
        fine.nnx[fi] = coarse.nnx[ci] * 2 + (x & 1);
        fine.nny[fi] = coarse.nny[ci] * 2 + (y & 1);
        fine.nnA[fi] = coarse.nnA[ci];
        fine.nnS[fi] = coarse.nnS[ci];
        fine.nnM[fi] = coarse.nnM[ci];
        fine.nnD[fi] = 1e30;              // finite, so propagation will use it
      }
    }
  }
}

/* --------------------------------- the seam -------------------------------- */

// Copied material almost never sits at quite the right brightness, so a fill
// can be perfectly textured and still read as a shape stuck on the picture.
// The difference is measured all along the join, held fixed there, and averaged
// inward until it dies away — the soap film across a bent wire, which is the
// usual way of hiding a seam. Smooth everywhere inside, exactly right at the
// edge, and it cannot touch detail because it has no detail in it.
const SEAM_LIMIT = 48;
const SEAM_PASSES = 320;

function seamField(base) {
  const { w, h, hole, rgb } = base;
  const n = w * h;
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
      cur[i * 3] = sr / c; cur[i * 3 + 1] = sg / c; cur[i * 3 + 2] = sb / c;
      fixed[i] = 1;
    }
  }

  // Only the inside of the hole ever moves, so those pixels are listed once and
  // only they are touched — everything else is identical in both buffers and
  // needs copying once rather than on every pass.
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

  // One ring outside carries its neighbour's value, so reading the field at
  // full resolution does not fade it away right at the join.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (hole[i]) continue;
      let r = 0, g = 0, b = 0, c = 0;
      const take = (j) => {
        if (!hole[j]) return;
        r += cur[j * 3]; g += cur[j * 3 + 1]; b += cur[j * 3 + 2]; c++;
      };
      if (x > 0) take(i - 1);
      if (x < w - 1) take(i + 1);
      if (y > 0) take(i - w);
      if (y < h - 1) take(i + w);
      if (c) { cur[i * 3] = r / c; cur[i * 3 + 1] = g / c; cur[i * 3 + 2] = b / c; }
    }
  }
  return cur;
}

/* --------------------------------- the job -------------------------------- */

function maskBounds(mask, iw, ih) {
  const probe = 400;
  const s = Math.min(1, probe / Math.max(iw, ih));
  const pw = Math.max(1, Math.round(iw * s)), ph = Math.max(1, Math.round(ih * s));
  const c = document.createElement("canvas");
  c.width = pw; c.height = ph;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(mask, 0, 0, pw, ph);
  const px = ctx.getImageData(0, 0, pw, ph).data;

  let minX = pw, minY = ph, maxX = -1, maxY = -1, painted = 0;
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      if (px[(y * pw + x) * 4 + 3] <= 24) continue;
      painted++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;

  const x0 = minX / s, y0 = minY / s, x1 = (maxX + 1) / s, y1 = (maxY + 1) / s;
  // The collar is the material the fill may draw on, so for a big object it
  // wants to be generous — what was behind a tree is a long way from the tree.
  const pad = Math.max(48, Math.max(x1 - x0, y1 - y0) * 1.6);
  const rx = Math.max(0, Math.floor(x0 - pad)), ry = Math.max(0, Math.floor(y0 - pad));
  const hx = Math.max(0, Math.floor(x0)), hy = Math.max(0, Math.floor(y0));

  return {
    x: rx, y: ry,
    w: Math.min(iw, Math.ceil(x1 + pad)) - rx,
    h: Math.min(ih, Math.ceil(y1 + pad)) - ry,
    holeArea: painted / (s * s),
    hx, hy,
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

// Draw a scaled copy of the region, and its mask, at some resolution.
function regionAt(image, mask, region, scale) {
  const w = Math.max(8, Math.round(region.w * scale));
  const h = Math.max(8, Math.round(region.h * scale));

  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, region.x, region.y, region.w, region.h, 0, 0, w, h);
  const pixels = ctx.getImageData(0, 0, w, h).data;

  const mc = document.createElement("canvas");
  mc.width = w; mc.height = h;
  const mctx = mc.getContext("2d", { willReadFrequently: true });
  mctx.drawImage(mask, region.x, region.y, region.w, region.h, 0, 0, w, h);
  const maskPixels = mctx.getImageData(0, 0, w, h).data;

  return { w, h, pixels, maskPixels };
}

/**
 * Fill in whatever the mask covers.
 *
 * `image` is anything drawable, `mask` a canvas the same shape whose alpha says
 * what to remove. Returns a canvas at the image's own size, or null if there
 * was nothing to do.
 */
export async function healRegion({ image, mask, guess, onProgress }) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;

  const say = (m) => { if (onProgress) onProgress(m); };
  const breathe = () => new Promise((r) => setTimeout(r, 0));

  say("Reading the picture…");
  const region = maskBounds(mask, iw, ih);
  if (!region) return null;

  const rng = seededRandom(12345);

  // Ask whoever called us whether they have a guess at what is behind it. They
  // may not — no model on this machine, a browser too old for it, weights that
  // would not load — and everything below works either way, just less well.
  let hint = null;
  if (guess) {
    try { hint = await guess(region); } catch { hint = null; }
  }

  /* ---- 1. complete it small, where the search can afford to look around --- */

  const mapScale = Math.min(
    1,
    WORK / Math.max(region.w, region.h),
    Math.sqrt(HOLE_BUDGET / Math.max(1, region.holeArea)),
  );
  const small = regionAt(image, mask, region, mapScale);
  const base = levelFromImageData(small.pixels, small.w, small.h, small.maskPixels);

  let any = false;
  for (let i = 0; i < base.hole.length; i++) if (base.hole[i]) { any = true; break; }
  if (!any) return null;

  const pyramid = [base];
  while (Math.min(pyramid[pyramid.length - 1].w, pyramid[pyramid.length - 1].h) > COARSEST) {
    pyramid.push(shrink(pyramid[pyramid.length - 1]));
  }

  // A guess from the network, if there is one, is a far better starting point
  // than anything grown from the edge: it already says where the ground meets
  // the hedge behind the thing that was removed. Where it exists the matcher is
  // also allowed to take it more seriously (W_GUIDED rather than W_UNSET),
  // because for once the contents of the hole mean something.
  if (hint) {
    seedFromGuide(pyramid[pyramid.length - 1], hint);
    for (const lv of pyramid) lv.guided = true;
  } else {
    seedHole(pyramid[pyramid.length - 1]);
  }
  for (let li = pyramid.length - 1; li >= 0; li--) {
    say(`Working out what was behind it… ${pyramid.length - li}/${pyramid.length}`);
    await breathe();
    // The coarsest levels decide the structure and are cheap, so they get the
    // most rounds; the finest only has to add detail to an answer already
    // roughly right.
    const rounds = Math.round(REFINE_MIN + (REFINE_MAX - REFINE_MIN) * (li / Math.max(1, pyramid.length - 1)));
    await solveLevel(pyramid[li], rng, breathe, rounds);
    if (li > 0) upsampleInto(pyramid[li], pyramid[li - 1]);
  }

  /* ---- 2. refine the match field at something near the real resolution ---- */

  const midScale = Math.min(1, Math.sqrt(MID_BUDGET / Math.max(1, region.w * region.h)));
  let guide = base, guideScale = mapScale;

  if (midScale > mapScale * 1.3) {
    say("Looking again, close up…");
    await breathe();
    const midData = regionAt(image, mask, region, midScale);
    const mid = levelFromImageData(midData.pixels, midData.w, midData.h, midData.maskPixels);
    carryInto(base, mid);
    const order = bandOrder(mid);
    const minDist = holeDistance(mid);
    const sources = [];
    for (let i = 0, n = mid.w * mid.h; i < n; i++) {
      if (minDist[i] > HALF * SCALE_HI * 1.45 + 1) sources.push(i);
    }
    if (order.length && sources.length) {
      computeLuma(mid);
      // Copied outright, never averaged: by this resolution the structure is
      // settled and the only thing still wanted is the photograph's own grain.
      await onionCopy(mid, order, rng, sources, minDist, MID_RADIUS, breathe, MID_ITERS);
      guide = mid; guideScale = midScale;
    }
  }

  /* ---- 3. copy camera pixels through the finished field ------------------- */

  say("Copying the real pixels in…");
  await breathe();
  return synthesize(image, mask, region, guide, guideScale, iw, ih);
}

// Move a solved field onto a finer grid of arbitrary ratio (the pyramid's own
// step is a clean halving; this one is not).
function carryInto(from, to) {
  initNNF(to);
  const rx = from.w / to.w, ry = from.h / to.h;
  for (let y = 0; y < to.h; y++) {
    const sy = Math.min(from.h - 1, (y * ry) | 0);
    for (let x = 0; x < to.w; x++) {
      const ti = y * to.w + x;
      if (!to.hole[ti]) continue;
      const sx = Math.min(from.w - 1, (x * rx) | 0);
      const si = sy * from.w + sx;
      to.rgb[ti * 3] = from.rgb[si * 3];
      to.rgb[ti * 3 + 1] = from.rgb[si * 3 + 1];
      to.rgb[ti * 3 + 2] = from.rgb[si * 3 + 2];
      if (from.nnD && from.nnD[si] < Infinity) {
        // Offsets scale; a position does not.
        to.nnx[ti] = clamp(Math.round(x + (from.nnx[si] - sx) / rx), 0, to.w - 1);
        to.nny[ti] = clamp(Math.round(y + (from.nny[si] - sy) / ry), 0, to.h - 1);
        to.nnA[ti] = from.nnA[si];
        to.nnS[ti] = from.nnS[si];
        to.nnM[ti] = from.nnM[si];
        to.nnD[ti] = 1e30;
      }
    }
  }
}

/* ---------------------------- the full-size copy --------------------------- */

// The field says, for each pixel of the hole, which part of the photograph its
// material comes from. Here that becomes pixels — at the photo's own
// resolution, by copying, never by enlarging. The field is read as an offset
// rather than a destination: "180 pixels left and 40 up" scales to any
// resolution, "pixel (212, 88) of the thumbnail" does not.
function synthesize(image, mask, region, guide, guideScale, iw, ih) {
  const { w, h, nnx, nny, nnD, hole, rgb } = guide;

  const fine = Math.min(1, Math.sqrt(FINE_BUDGET / Math.max(1, region.w * region.h)));
  const rw = Math.max(1, Math.round(region.w * fine)), rh = Math.max(1, Math.round(region.h * fine));
  const k = rw / w;

  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = rw; srcCanvas.height = rh;
  const srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true });
  srcCtx.drawImage(image, region.x, region.y, region.w, region.h, 0, 0, rw, rh);
  const src = srcCtx.getImageData(0, 0, rw, rh).data;

  const masked = new Uint8Array(rw * rh);
  {
    const mk = document.createElement("canvas");
    mk.width = rw; mk.height = rh;
    const mctx = mk.getContext("2d", { willReadFrequently: true });
    mctx.drawImage(mask, region.x, region.y, region.w, region.h, 0, 0, rw, rh);
    const md = mctx.getImageData(0, 0, rw, rh).data;
    for (let i = 0, n = rw * rh; i < n; i++) masked[i] = md[i * 4 + 3] > 24 ? 1 : 0;
  }

  const field = seamField(guide);
  const shift = (ch, mxf, myf) => {
    const x0 = Math.floor(mxf), y0 = Math.floor(myf);
    const fx = mxf - x0, fy = myf - y0;
    const ax = clamp(x0, 0, w - 1), bx2 = clamp(x0 + 1, 0, w - 1);
    const ay = clamp(y0, 0, h - 1), by2 = clamp(y0 + 1, 0, h - 1);
    const g = (xx, yy) => field[(yy * w + xx) * 3 + ch];
    const v = g(ax, ay) * (1 - fx) * (1 - fy) + g(bx2, ay) * fx * (1 - fy)
      + g(ax, by2) * (1 - fx) * fy + g(bx2, by2) * fx * fy;
    return clamp(v, -SEAM_LIMIT, SEAM_LIMIT);
  };

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

      if (!masked[fi]) {
        out[o] = src[fi * 4]; out[o + 1] = src[fi * 4 + 1]; out[o + 2] = src[fi * 4 + 2]; out[o + 3] = 255;
        continue;
      }

      const mxf = (X + 0.5) / k - 0.5, myf = (Y + 0.5) / k - 0.5;
      const mx = clamp(Math.round(mxf), 0, w - 1);
      const my = clamp(Math.round(myf), 0, h - 1);
      let mi = my * w + mx;

      const dr = shift(0, mxf, myf), dg = shift(1, mxf, myf), db = shift(2, mxf, myf);

      // The brush's edge is softer at full size than on the field, so a pixel
      // can be hole here while its field pixel is not. Borrow the nearest that is.
      if (!hole[mi] || nnD[mi] === Infinity) {
        let found = -1;
        for (let r = 1; r <= 3 && found < 0; r++) {
          for (let dy = -r; dy <= r && found < 0; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              const nx = clamp(mx + dx, 0, w - 1), ny = clamp(my + dy, 0, h - 1);
              const ni = ny * w + nx;
              if (hole[ni] && nnD[ni] < Infinity) { found = ni; break; }
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
