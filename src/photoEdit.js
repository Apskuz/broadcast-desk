/* --------------------------------------------------------------------------
 * The develop model: every number a picture on the board can carry.
 *
 * Nothing here touches the file in Drive. A picture is the original bytes plus
 * a bag of numbers, exactly like the crop always was — so an edit costs no
 * storage, rides through undo, copies from one photo to another, and can be put
 * back to the original at any point years later.
 *
 * The set of controls is Lightroom's develop module, panel for panel, because
 * that is the vocabulary people already have: if you know what Highlights does
 * there, it does the same thing here. The maths is ours (see photoRender.js),
 * the shape of the controls is theirs.
 * ------------------------------------------------------------------------ */

// The eight bands Lightroom's colour mixer splits the wheel into, with the hue
// each one sits at. Anything between two bands is shared between them, which is
// why sliding "Orange" also moves skin tones that lean red.
export const HSL_BANDS = [
  { id: "red", label: "Red", hue: 0, swatch: "#D9564B" },
  { id: "orange", label: "Orange", hue: 30, swatch: "#D98C3F" },
  { id: "yellow", label: "Yellow", hue: 60, swatch: "#D9C23F" },
  { id: "green", label: "Green", hue: 120, swatch: "#6FBE7A" },
  { id: "aqua", label: "Aqua", hue: 180, swatch: "#4FB8A6" },
  { id: "blue", label: "Blue", hue: 240, swatch: "#5A7FD9" },
  { id: "purple", label: "Purple", hue: 285, swatch: "#9A6FD9" },
  { id: "magenta", label: "Magenta", hue: 330, swatch: "#D95A9E" },
];

const flatBand = { h: 0, s: 0, l: 0 };

// Two control points is a straight line: the curve starts doing nothing.
export const CURVE_LINE = [{ x: 0, y: 0 }, { x: 255, y: 255 }];

export const EDIT_DEFAULTS = {
  /* ---- Light ---- */
  exposure: 0,          // EV, -5..+5, the one control that is genuinely linear
  contrast: 0,          // -100..100
  highlights: 0,        // -100..100, recovers or opens the bright end
  shadows: 0,           // -100..100
  whites: 0,            // -100..100, where the top of the range lands
  blacks: 0,            // -100..100

  /* ---- Colour ---- */
  temp: 0,              // -100..100, blue <-> yellow, relative to the file as shot
  tint: 0,              // -100..100, green <-> magenta
  vibrance: 0,          // -100..100, leans on the least saturated colours
  saturation: 0,        // -100..100, everything equally

  /* ---- Presence ---- */
  texture: 0,           // -100..100, fine detail only; smooths skin when negative
  clarity: 0,           // -100..100, mid-frequency local contrast
  dehaze: 0,            // -100..100
  blur: 0,              // 0..12; not a Lightroom control, but boards used it before this panel existed

  /* ---- Tone curve ---- */
  // Parametric: four regions with movable splits, the safe way to bend tone.
  parHighlights: 0, parLights: 0, parDarks: 0, parShadows: 0,
  splitShadow: 25, splitMid: 50, splitHigh: 75,
  // Point curves, 0..255 in and out. Master plus one per channel.
  curveRGB: CURVE_LINE, curveR: CURVE_LINE, curveG: CURVE_LINE, curveB: CURVE_LINE,

  /* ---- Colour mixer (HSL) ---- */
  hsl: Object.fromEntries(HSL_BANDS.map((b) => [b.id, { ...flatBand }])),

  /* ---- Colour grading ---- */
  gradeShadow: { ...flatBand }, gradeMid: { ...flatBand },
  gradeHigh: { ...flatBand }, gradeGlobal: { ...flatBand },
  gradeBlend: 50,       // 0..100, how far the three zones bleed into each other
  gradeBalance: 0,      // -100..100, which way the shadow/highlight split leans

  /* ---- Detail ---- */
  sharpAmount: 0,       // 0..150
  sharpRadius: 1,       // 0.5..3
  sharpDetail: 25,      // 0..100, how much of the halo suppression to drop
  sharpMask: 0,         // 0..100, keeps sharpening off flat areas like sky
  nrLuminance: 0,       // 0..100
  nrDetail: 50,         // 0..100
  nrContrast: 0,        // 0..100
  nrColor: 25,          // 0..100, colour speckle — on by default, as in Lightroom
  nrColorDetail: 50,    // 0..100

  /* ---- Optics ---- */
  distortion: 0,        // -100..100, barrel <-> pincushion
  lensVignette: 0,      // 0..100, undoes the lens darkening the corners
  defringe: 0,          // 0..100
  caAmount: 0,          // -100..100, pulls the red and blue planes apart

  /* ---- Geometry ---- */
  spin: 0,              // whole quarter turns, kept apart so it survives a straighten
  straighten: 0,        // -45..45 degrees
  flipH: false, flipV: false,
  perspV: 0, perspH: 0, // -100..100, keystone
  perspRotate: 0,       // -45..45
  geoAspect: 0,         // -100..100, stretch
  geoScale: 100,        // 50..200
  geoX: 0, geoY: 0,     // -100..100, pan inside the frame

  /* ---- Effects ---- */
  vignette: 0,          // -100..100
  vignetteMid: 50, vignetteRound: 0, vignetteFeather: 50, vignetteHigh: 0,
  grain: 0,             // 0..100
  grainSize: 25, grainRough: 50,

  /* ---- Calibration ---- */
  calShadow: 0,         // -100..100, tint in the shadows
  calRedH: 0, calRedS: 0, calGreenH: 0, calGreenS: 0, calBlueH: 0, calBlueS: 0,

  /* ---- Masks ---- */
  masks: [],            // see MASK_DEFAULTS
};

// What a local adjustment can change. Deliberately a subset: these are the ones
// that mean something applied to part of a picture, and keeping the list short
// keeps the shader — which runs this for every mask, for every pixel — sane.
export const MASK_ADJUST_DEFAULTS = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temp: 0, tint: 0, saturation: 0, clarity: 0, dehaze: 0, sharpness: 0, blur: 0,
};

export const MASK_DEFAULTS = {
  type: "radial",       // radial | linear | brush
  invert: false,
  hidden: false,
  amount: 100,          // 0..100, the whole mask's strength
  // radial: an ellipse in 0..1 picture space
  cx: 0.5, cy: 0.5, rx: 0.28, ry: 0.28, angle: 0, feather: 50,
  // linear: the line the gradient runs across, also 0..1
  x1: 0.5, y1: 0.25, x2: 0.5, y2: 0.75,
  // brush: strokes of { x, y, r, erase }, rasterised rather than solved per pixel
  strokes: [],
  brushSize: 0.08, brushFeather: 50, brushFlow: 100,
  adjust: { ...MASK_ADJUST_DEFAULTS },
};

/* ------------------------- the panels, as rendered ------------------------ */
// One description of every slider, used to draw the UI, to reset a control, to
// clamp a pasted value, and to work out whether a panel has been touched.
const S = (key, label, min, max, step = 1) => ({ key, label, min, max, step });

export const EDIT_PANELS = [
  {
    id: "light", label: "Light",
    sliders: [
      S("exposure", "Exposure", -5, 5, 0.01),
      S("contrast", "Contrast", -100, 100),
      S("highlights", "Highlights", -100, 100),
      S("shadows", "Shadows", -100, 100),
      S("whites", "Whites", -100, 100),
      S("blacks", "Blacks", -100, 100),
    ],
  },
  {
    id: "color", label: "Colour",
    sliders: [
      S("temp", "Temperature", -100, 100),
      S("tint", "Tint", -100, 100),
      S("vibrance", "Vibrance", -100, 100),
      S("saturation", "Saturation", -100, 100),
    ],
  },
  {
    id: "presence", label: "Presence",
    sliders: [
      S("texture", "Texture", -100, 100),
      S("clarity", "Clarity", -100, 100),
      S("dehaze", "Dehaze", -100, 100),
      S("blur", "Blur", 0, 12, 0.5),
    ],
  },
  {
    id: "curve", label: "Tone curve",
    custom: "curve",
    sliders: [
      S("parHighlights", "Highlights", -100, 100),
      S("parLights", "Lights", -100, 100),
      S("parDarks", "Darks", -100, 100),
      S("parShadows", "Shadows", -100, 100),
    ],
  },
  { id: "mixer", label: "Colour mixer", custom: "mixer", sliders: [] },
  {
    id: "grading", label: "Colour grading",
    custom: "grading",
    sliders: [
      S("gradeBlend", "Blending", 0, 100),
      S("gradeBalance", "Balance", -100, 100),
    ],
  },
  {
    id: "detail", label: "Detail",
    sliders: [
      S("sharpAmount", "Sharpening", 0, 150),
      S("sharpRadius", "Radius", 0.5, 3, 0.1),
      S("sharpDetail", "Detail", 0, 100),
      S("sharpMask", "Masking", 0, 100),
      S("nrLuminance", "Noise reduction", 0, 100),
      S("nrDetail", "NR detail", 0, 100),
      S("nrContrast", "NR contrast", 0, 100),
      S("nrColor", "Colour noise", 0, 100),
      S("nrColorDetail", "Colour detail", 0, 100),
    ],
  },
  {
    id: "optics", label: "Optics",
    sliders: [
      S("distortion", "Distortion", -100, 100),
      S("lensVignette", "Vignetting", 0, 100),
      S("defringe", "Defringe", 0, 100),
      S("caAmount", "Chromatic aberration", -100, 100),
    ],
  },
  {
    id: "geometry", label: "Geometry",
    custom: "geometry",
    sliders: [
      S("straighten", "Straighten", -45, 45, 0.1),
      S("perspV", "Vertical", -100, 100),
      S("perspH", "Horizontal", -100, 100),
      S("perspRotate", "Rotate", -45, 45, 0.1),
      S("geoAspect", "Aspect", -100, 100),
      S("geoScale", "Scale", 50, 200),
      S("geoX", "X offset", -100, 100),
      S("geoY", "Y offset", -100, 100),
    ],
  },
  {
    id: "effects", label: "Effects",
    sliders: [
      S("vignette", "Vignette", -100, 100),
      S("vignetteMid", "Midpoint", 0, 100),
      S("vignetteRound", "Roundness", -100, 100),
      S("vignetteFeather", "Feather", 0, 100),
      S("vignetteHigh", "Highlights", 0, 100),
      S("grain", "Grain", 0, 100),
      S("grainSize", "Size", 0, 100),
      S("grainRough", "Roughness", 0, 100),
    ],
  },
  {
    id: "calibration", label: "Calibration",
    sliders: [
      S("calShadow", "Shadow tint", -100, 100),
      S("calRedH", "Red hue", -100, 100),
      S("calRedS", "Red saturation", -100, 100),
      S("calGreenH", "Green hue", -100, 100),
      S("calGreenS", "Green saturation", -100, 100),
      S("calBlueH", "Blue hue", -100, 100),
      S("calBlueS", "Blue saturation", -100, 100),
    ],
  },
];

export const MASK_SLIDERS = [
  S("exposure", "Exposure", -5, 5, 0.01),
  S("contrast", "Contrast", -100, 100),
  S("highlights", "Highlights", -100, 100),
  S("shadows", "Shadows", -100, 100),
  S("whites", "Whites", -100, 100),
  S("blacks", "Blacks", -100, 100),
  S("temp", "Temperature", -100, 100),
  S("tint", "Tint", -100, 100),
  S("saturation", "Saturation", -100, 100),
  S("clarity", "Clarity", -100, 100),
  S("dehaze", "Dehaze", -100, 100),
  S("sharpness", "Sharpness", 0, 100),
  S("blur", "Blur", 0, 100),
];

// Every slider in one lookup, so a control can be reset or clamped by key alone.
export const SLIDER_BY_KEY = (() => {
  const map = {};
  for (const panel of EDIT_PANELS) for (const s of panel.sliders) map[s.key] = s;
  return map;
})();

/* ------------------------------- housekeeping ----------------------------- */

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// A saved look only holds what was actually changed, so reading one back means
// laying it over the defaults. Two levels deep is enough: the nested things are
// all flat bags of three numbers.
export function fullEdit(look) {
  const out = { ...EDIT_DEFAULTS, ...(look || {}) };
  out.hsl = { ...EDIT_DEFAULTS.hsl };
  for (const band of HSL_BANDS) {
    out.hsl[band.id] = { ...flatBand, ...((look && look.hsl && look.hsl[band.id]) || {}) };
  }
  for (const key of ["gradeShadow", "gradeMid", "gradeHigh", "gradeGlobal"]) {
    out[key] = { ...flatBand, ...((look && look[key]) || {}) };
  }
  out.masks = ((look && look.masks) || []).map(fullMask);
  return out;
}

export function fullMask(mask) {
  return {
    ...MASK_DEFAULTS,
    ...(mask || {}),
    strokes: ((mask && mask.strokes) || []).map((s) => ({ ...s })),
    adjust: { ...MASK_ADJUST_DEFAULTS, ...((mask && mask.adjust) || {}) },
  };
}

// The other direction: throw away everything still at its default so the board
// stays small. A board with fifty photos on it is one row in the database, and
// writing out three hundred zeroes per picture would bloat every save.
export function trimEdit(edit) {
  const out = {};
  for (const [key, value] of Object.entries(edit || {})) {
    const base = EDIT_DEFAULTS[key];
    if (key === "hsl") {
      const bands = {};
      for (const band of HSL_BANDS) {
        const b = value[band.id] || {};
        const kept = {};
        for (const k of ["h", "s", "l"]) if (b[k]) kept[k] = b[k];
        if (Object.keys(kept).length) bands[band.id] = kept;
      }
      if (Object.keys(bands).length) out.hsl = bands;
      continue;
    }
    if (key === "masks") {
      const masks = (value || []).filter((m) => m && (m.type !== "brush" || (m.strokes || []).length));
      if (masks.length) out.masks = masks.map(trimMask);
      continue;
    }
    if (isPlainObject(base)) {
      const kept = {};
      for (const k of Object.keys(base)) if (value[k] !== base[k]) kept[k] = value[k];
      if (Object.keys(kept).length) out[key] = kept;
      continue;
    }
    if (Array.isArray(base)) {                     // the four point curves
      if (!isFlatCurve(value)) out[key] = value.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
      continue;
    }
    if (value !== base) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

function trimMask(mask) {
  const out = { id: mask.id, type: mask.type };
  for (const [key, value] of Object.entries(mask)) {
    if (key === "id" || key === "type" || key === "adjust") continue;
    if (key === "strokes") { if ((value || []).length) out.strokes = value; continue; }
    if (value !== MASK_DEFAULTS[key]) out[key] = value;
  }
  const adjust = {};
  for (const [key, value] of Object.entries(mask.adjust || {})) {
    if (value !== MASK_ADJUST_DEFAULTS[key]) adjust[key] = value;
  }
  if (Object.keys(adjust).length) out.adjust = adjust;
  return out;
}

export const isFlatCurve = (pts) =>
  !pts || pts.length === 2 &&
  pts[0].x === 0 && pts[0].y === 0 && pts[1].x === 255 && pts[1].y === 255;

// Has anything at all been done to this picture? Drives the "Edited" dot on the
// board and whether the before/after button is worth offering.
export function hasEdit(look) {
  return !!trimEdit(fullEdit(look));
}

// Which panels have been touched, so each one can show a dot without the UI
// having to know what any individual control means.
export function touchedPanels(edit) {
  const touched = {};
  for (const panel of EDIT_PANELS) {
    let dirty = panel.sliders.some(({ key }) => edit[key] !== EDIT_DEFAULTS[key]);
    if (panel.id === "curve") {
      dirty = dirty || ["curveRGB", "curveR", "curveG", "curveB"].some((k) => !isFlatCurve(edit[k]));
    }
    if (panel.id === "mixer") {
      dirty = HSL_BANDS.some((b) => { const v = edit.hsl[b.id]; return v.h || v.s || v.l; });
    }
    if (panel.id === "grading") {
      dirty = dirty || ["gradeShadow", "gradeMid", "gradeHigh", "gradeGlobal"]
        .some((k) => edit[k].h || edit[k].s || edit[k].l);
    }
    if (panel.id === "geometry") {
      dirty = dirty || edit.spin !== 0 || edit.flipH || edit.flipV;
    }
    touched[panel.id] = dirty;
  }
  return touched;
}

/* ------------------------------- the old look ----------------------------- */
// The first version of this panel had five CSS-filter sliders. Boards still
// carry them, and a picture someone set up a year ago must look the same today,
// so the old numbers are read as the nearest thing in the new model rather than
// being thrown away or left to mean something different.
const LEGACY_KEYS = ["exposure", "contrast", "saturation", "warmth", "blur", "spin"];

export function migrateLook(look) {
  if (!look) return null;
  // Anything the old panel never had means it is already the new shape.
  const legacyOnly = Object.keys(look).every((k) => LEGACY_KEYS.includes(k));
  if (!legacyOnly) return look;
  const out = {};
  // brightness(1 + e/100) is a straight multiply, and exposure is measured in
  // stops, so the same visual change is log2 of that multiplier.
  if (look.exposure) out.exposure = Math.round(Math.log2(1 + look.exposure / 100) * 100) / 100;
  if (look.contrast) out.contrast = look.contrast;
  if (look.saturation) out.saturation = look.saturation;
  if (look.warmth) out.temp = look.warmth;
  if (look.blur) out.blur = look.blur;
  if (look.spin) out.spin = look.spin;
  return Object.keys(out).length ? out : null;
}

/* --------------------------------- curves --------------------------------- */

// Monotone cubic (Fritsch–Carlson). A plain spline through hand-placed points
// overshoots — drag one point up and the curve dips below its neighbour on the
// way there, which on a photo shows as a band of the wrong tone. This never
// does that: between any two points the curve only ever goes one way.
export function curveLUT(points, out) {
  const lut = out || new Float32Array(256);
  const pts = [...(points || CURVE_LINE)].sort((a, b) => a.x - b.x);
  if (pts.length < 2) { for (let i = 0; i < 256; i++) lut[i] = i / 255; return lut; }

  const n = pts.length;
  const dx = [], slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = Math.max(1e-6, pts[i + 1].x - pts[i].x);
    slope[i] = (pts[i + 1].y - pts[i].y) / dx[i];
  }
  const m = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) m[i] = 0;          // a turning point: flatten it
    else {
      const w1 = 2 * dx[i] + dx[i - 1], w2 = dx[i] + 2 * dx[i - 1];
      m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }

  let seg = 0;
  for (let i = 0; i < 256; i++) {
    const x = i;
    while (seg < n - 2 && x > pts[seg + 1].x) seg++;
    let y;
    if (x <= pts[0].x) y = pts[0].y + (x - pts[0].x) * m[0];
    else if (x >= pts[n - 1].x) y = pts[n - 1].y + (x - pts[n - 1].x) * m[n - 1];
    else {
      const h = dx[seg], t = (x - pts[seg].x) / h, t2 = t * t, t3 = t2 * t;
      y = (2 * t3 - 3 * t2 + 1) * pts[seg].y
        + (t3 - 2 * t2 + t) * h * m[seg]
        + (-2 * t3 + 3 * t2) * pts[seg + 1].y
        + (t3 - t2) * h * m[seg + 1];
    }
    lut[i] = Math.min(1, Math.max(0, y / 255));
  }
  return lut;
}

// The parametric curve: four regions whose splits can be moved. Each slider
// pushes its own region and fades out through the neighbouring ones, so the
// result is always smooth — which is the whole reason this curve exists
// alongside the point curve.
export function parametricLUT(edit, out) {
  const lut = out || new Float32Array(256);
  const sh = edit.splitShadow / 100, mid = edit.splitMid / 100, hi = edit.splitHigh / 100;
  const centres = [sh / 2, (sh + mid) / 2, (mid + hi) / 2, (hi + 1) / 2];
  const amounts = [edit.parShadows, edit.parDarks, edit.parLights, edit.parHighlights];
  const width = Math.max(0.08, (hi - sh) / 3);

  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    // Pure black and pure white stay where they are. Without this the Shadows
    // slider lifts the black point off the floor and the picture goes milky,
    // which is not what any of these four sliders is supposed to do — that is
    // what Blacks and Whites are for.
    const ends = Math.min(1, Math.min(x, 1 - x) / 0.1);
    let y = x;
    for (let r = 0; r < 4; r++) {
      const a = amounts[r];
      if (!a) continue;
      const d = (x - centres[r]) / width;
      const w = Math.exp(-d * d) * ends;
      // Headroom-aware: pushing up can only use what is left above, pushing
      // down only what is there below, so the curve stays inside 0..1.
      y += (a / 100) * 0.32 * w * (a > 0 ? 1 - y : y);
    }
    lut[i] = Math.min(1, Math.max(0, y));
  }
  return lut;
}

/* ------------------------------ histogram/auto ---------------------------- */

// Counts drawn from a small copy of the picture — 200px is plenty for a shape
// you read at a glance, and doing it full size would stall the editor on every
// change.
export function histogramOf(canvasOrImage, bins = 128) {
  const w = 200, h = Math.max(1, Math.round(w * (canvasOrImage.height / canvasOrImage.width) || w));
  const scratch = document.createElement("canvas");
  scratch.width = w; scratch.height = h;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  try { ctx.drawImage(canvasOrImage, 0, 0, w, h); } catch { return null; }
  let px;
  try { px = ctx.getImageData(0, 0, w, h).data; } catch { return null; }

  const r = new Uint32Array(bins), g = new Uint32Array(bins), b = new Uint32Array(bins), l = new Uint32Array(bins);
  const scale = bins / 256;
  for (let i = 0; i < px.length; i += 4) {
    r[Math.min(bins - 1, (px[i] * scale) | 0)]++;
    g[Math.min(bins - 1, (px[i + 1] * scale) | 0)]++;
    b[Math.min(bins - 1, (px[i + 2] * scale) | 0)]++;
    const lum = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    l[Math.min(bins - 1, (lum * scale) | 0)]++;
  }
  const peak = Math.max(1, ...r, ...g, ...b);
  return { r, g, b, l, bins, peak, total: px.length / 4 };
}

// Auto: read where the tones actually sit and move the six light sliders to put
// them where they usually want to be. Not Adobe's model — that one is trained —
// but the same instinct: lift a flat picture, hold the top back, open the floor.
export function autoTone(hist) {
  if (!hist) return {};
  const { l, bins, total } = hist;
  const at = (fraction) => {
    let seen = 0;
    const want = total * fraction;
    for (let i = 0; i < bins; i++) { seen += l[i]; if (seen >= want) return i / (bins - 1); }
    return 1;
  };
  const black = at(0.005), shadow = at(0.15), mid = at(0.5), high = at(0.85), white = at(0.995);

  const out = {};
  // Put the median where a well-exposed frame usually sits.
  const wanted = 0.46;
  if (mid > 0.02 && mid < 0.98) out.exposure = clamp(Math.log2(wanted / mid), -2.5, 2.5, 0.01);
  // A picture using little of the range wants contrast; one already using it all does not.
  const spread = white - black;
  out.contrast = Math.round(clamp((0.82 - spread) * 160, -30, 45, 1));
  out.highlights = Math.round(clamp((high - 0.82) * -260, -85, 20, 1));
  out.shadows = Math.round(clamp((0.2 - shadow) * 300, -20, 85, 1));
  out.whites = Math.round(clamp((0.96 - white) * 220, -40, 45, 1));
  out.blacks = Math.round(clamp((0.035 - black) * 260, -45, 40, 1));
  return out;
}

const clamp = (v, lo, hi, step) => {
  const c = Math.min(hi, Math.max(lo, v));
  return step ? Math.round(c / step) * step : c;
};

/* --------------------------------- presets -------------------------------- */
// Starting points, not destinations: each one is a normal set of numbers, so it
// lands in the sliders and can be pushed around afterwards like anything you
// dialled in yourself.
const band = (h, s, l) => ({ h, s, l });

export const PRESET_GROUPS = [
  {
    id: "basic", label: "Basics",
    presets: [
      { id: "none", label: "Original", look: {} },
      { id: "auto-punch", label: "Punch", look: { contrast: 22, clarity: 18, vibrance: 24, blacks: -12, whites: 10 } },
      { id: "soft", label: "Soft", look: { contrast: -16, highlights: -20, shadows: 24, texture: -14, vibrance: 8 } },
      { id: "flat", label: "Flat", look: { contrast: -28, highlights: -35, shadows: 35, blacks: 22, whites: -18 } },
      { id: "crisp", label: "Crisp", look: { clarity: 26, texture: 22, sharpAmount: 55, sharpMask: 30, contrast: 12 } },
    ],
  },
  {
    id: "bw", label: "Black & white",
    presets: [
      { id: "bw-neutral", label: "Neutral", look: { saturation: -100, contrast: 12 } },
      {
        id: "bw-high", label: "High contrast",
        look: { saturation: -100, contrast: 38, blacks: -22, whites: 18, clarity: 20 },
      },
      {
        id: "bw-soft", label: "Soft grey",
        look: { saturation: -100, contrast: -12, blacks: 20, highlights: -18, texture: -10 },
      },
      {
        id: "bw-film", label: "Film",
        look: {
          saturation: -100, contrast: 18, blacks: 14, grain: 42, grainSize: 32, grainRough: 55,
          curveRGB: [{ x: 0, y: 14 }, { x: 64, y: 58 }, { x: 190, y: 202 }, { x: 255, y: 246 }],
        },
      },
      {
        id: "bw-red", label: "Red filter",
        look: {
          saturation: -100, contrast: 20,
          hsl: { red: band(0, 0, 45), orange: band(0, 0, 30), blue: band(0, 0, -42), aqua: band(0, 0, -30) },
        },
      },
    ],
  },
  {
    id: "film", label: "Film",
    presets: [
      {
        id: "portra", label: "Warm portrait",
        look: {
          temp: 14, tint: 6, contrast: -8, highlights: -22, shadows: 18, vibrance: 14, saturation: -6,
          hsl: { orange: band(6, -8, 8), red: band(4, -6, 4), green: band(-10, -18, 0) },
          gradeShadow: band(215, 12, 0), gradeHigh: band(45, 10, 0), gradeBlend: 60,
          curveRGB: [{ x: 0, y: 10 }, { x: 70, y: 66 }, { x: 185, y: 192 }, { x: 255, y: 250 }],
        },
      },
      {
        id: "fade", label: "Faded",
        look: {
          contrast: -20, blacks: 26, highlights: -14, saturation: -18, temp: 6,
          curveRGB: [{ x: 0, y: 28 }, { x: 128, y: 132 }, { x: 255, y: 238 }],
          grain: 22,
        },
      },
      {
        id: "cine", label: "Cinematic",
        look: {
          contrast: 14, highlights: -30, shadows: 20, blacks: -14, dehaze: 8, vibrance: -6, saturation: -8,
          gradeShadow: band(200, 26, -4), gradeHigh: band(38, 18, 2), gradeBalance: -12, gradeBlend: 65,
          hsl: { blue: band(-8, 12, -6), aqua: band(6, 14, 0), orange: band(-4, 6, 4) },
        },
      },
      {
        id: "cross", label: "Cross process",
        look: {
          contrast: 26, vibrance: 18,
          curveR: [{ x: 0, y: 22 }, { x: 128, y: 140 }, { x: 255, y: 245 }],
          curveB: [{ x: 0, y: 26 }, { x: 128, y: 118 }, { x: 255, y: 232 }],
          curveG: [{ x: 0, y: 8 }, { x: 128, y: 128 }, { x: 255, y: 252 }],
        },
      },
      {
        id: "sepia", label: "Sepia",
        look: {
          saturation: -100, contrast: 10,
          gradeGlobal: band(38, 32, 0), gradeShadow: band(30, 20, -4), gradeBlend: 70,
        },
      },
    ],
  },
  {
    id: "scene", label: "Scenes",
    presets: [
      {
        id: "landscape", label: "Landscape",
        look: {
          contrast: 16, clarity: 22, dehaze: 14, vibrance: 26, highlights: -30, shadows: 22, whites: 12,
          hsl: { green: band(-12, 18, -4), aqua: band(0, 22, -8), blue: band(-6, 20, -10) },
          sharpAmount: 60, sharpMask: 40,
        },
      },
      {
        id: "portrait", label: "Portrait",
        look: {
          contrast: -6, highlights: -18, shadows: 16, texture: -18, clarity: -8, vibrance: 12,
          hsl: { orange: band(4, -10, 10), red: band(2, -8, 6) },
          nrColor: 35, sharpAmount: 35, sharpMask: 55,
        },
      },
      {
        id: "night", label: "Night",
        look: {
          exposure: 0.35, contrast: 18, highlights: -42, shadows: 30, blacks: -18, dehaze: 10,
          nrLuminance: 32, nrColor: 45, vibrance: 16,
          gradeShadow: band(220, 18, -6),
        },
      },
      {
        id: "food", label: "Food",
        look: {
          temp: 8, contrast: 14, clarity: 16, texture: 14, vibrance: 22, highlights: -16, shadows: 12,
          hsl: { orange: band(0, 14, 4), yellow: band(-6, 12, 2), green: band(0, 10, 4) },
          vignette: -14, vignetteFeather: 60,
        },
      },
      {
        id: "product", label: "Product",
        look: {
          contrast: 10, whites: 18, blacks: -8, clarity: 14, texture: 18,
          sharpAmount: 70, sharpRadius: 1.2, sharpMask: 25, saturation: 4,
        },
      },
      {
        id: "moody", label: "Moody",
        look: {
          exposure: -0.3, contrast: 20, highlights: -36, shadows: -14, blacks: -22, dehaze: 12,
          saturation: -14, vibrance: 10, vignette: -28, vignetteFeather: 65,
          gradeShadow: band(210, 22, -6), gradeBlend: 60,
        },
      },
    ],
  },
];

export const ALL_PRESETS = PRESET_GROUPS.flatMap((g) => g.presets);

/* --------------------------------- crop ----------------------------------- */
// The ratios Lightroom offers, plus the ones this team actually posts in.
export const CROP_RATIOS = [
  { id: "free", label: "Free", ratio: null },
  { id: "original", label: "Original", ratio: "original" },
  { id: "1x1", label: "1:1", ratio: 1 },
  { id: "4x5", label: "4:5", ratio: 4 / 5 },
  { id: "9x16", label: "9:16", ratio: 9 / 16 },
  { id: "16x9", label: "16:9", ratio: 16 / 9 },
  { id: "3x2", label: "3:2", ratio: 3 / 2 },
  { id: "2x3", label: "2:3", ratio: 2 / 3 },
  { id: "4x3", label: "4:3", ratio: 4 / 3 },
  { id: "3x4", label: "3:4", ratio: 3 / 4 },
  { id: "5x7", label: "5:7", ratio: 5 / 7 },
];

// A short, honest label for a picture's state, used on the board and in lists.
export function editSummary(look) {
  const edit = fullEdit(migrateLook(look));
  const touched = touchedPanels(edit);
  const names = EDIT_PANELS.filter((p) => touched[p.id]).map((p) => p.label);
  if (edit.masks.length) names.push(`${edit.masks.length} mask${edit.masks.length > 1 ? "s" : ""}`);
  return names.join(" · ");
}
