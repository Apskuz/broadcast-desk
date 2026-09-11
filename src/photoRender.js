/* --------------------------------------------------------------------------
 * The develop engine.
 *
 * CSS filters got the first version of the picture panel a long way for nothing,
 * but they cannot do the things that make Lightroom Lightroom: highlights and
 * shadows are one control there, not a brightness multiply; a tone curve needs a
 * lookup, not a formula; clarity needs to know what the picture looks like
 * blurred; masks need to be worked out per pixel. All of that is a shader's job.
 *
 * So: one WebGL context, shared by the whole app, rendering into an offscreen
 * canvas that gets copied into whichever 2D canvas asked for a frame. One
 * context rather than one per photo matters — browsers cap you at around a
 * dozen and a board can hold fifty pictures.
 *
 * Everything degrades: if WebGL is missing or the context is lost, callers fall
 * back to the CSS approximation they used before, and the board still works.
 * ------------------------------------------------------------------------ */

import { fullEdit, curveLUT, parametricLUT, isFlatCurve, HSL_BANDS } from "./photoEdit";

export const MAX_MASKS = 8;
const MAX_BRUSH_SLOTS = 4;      // one per channel of the brush mask texture

/* ------------------------------- the shaders ------------------------------ */

const VERT = `
attribute vec2 aPos;
varying vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Pass one: geometry and optics. Everything that decides *which part of the
// original* a given output pixel comes from happens here — crop, straighten,
// quarter turns, flips, keystone, scale, pan, lens distortion and the colour
// planes being pulled apart. Doing it first means every later pass can treat
// the picture as a plain rectangle.
const GEOM_FRAG = `
precision highp float;
varying vec2 vUV;
uniform sampler2D uSrc;
uniform vec4 uCrop;          // x, y, w, h in 0..1 of the turned picture, y from the top
uniform float uDevAspect;    // width / height of the whole picture after turning, before cropping
uniform float uAngle;        // straighten + perspective rotate, radians
uniform float uSpinSteps;    // whole quarter turns, 0..3
uniform vec2  uFlip;         // 1.0 or -1.0 per axis
uniform vec2  uPersp;        // horizontal, vertical keystone
uniform vec2  uStretch;      // aspect adjustment per axis
uniform float uScale;
uniform vec2  uOffset;
uniform float uDistort;      // barrel <-> pincushion
uniform float uCA;           // chromatic aberration
uniform float uLensVig;      // corner brightening, to undo the lens

vec2 rot(vec2 p, float a) {
  float s = sin(a), c = cos(a);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

// A whole quarter turn swaps the two axes exactly, so it happens on the unit
// square, where the picture's proportions do not come into it. This is the
// inverse direction — turned frame back to source — and one step is clockwise,
// to match the button that drives it.
vec2 unTurn(vec2 p) {
  if (uSpinSteps < 0.5) return p;
  if (uSpinSteps < 1.5) return vec2(-p.y, p.x);
  if (uSpinSteps < 2.5) return vec2(-p.x, -p.y);
  return vec2(p.y, -p.x);
}

// Output pixel -> a point in the source, in 0..1. Anything outside that range
// fell off the picture, which the caller reads as "nothing here".
//
// The crop is applied *after* turning and straightening, not before, because
// that is the order you work in: you level the horizon and then decide where
// the edges go. It also means the crop rectangle means the same thing as the
// rectangle you dragged on screen.
vec2 toSource(vec2 uv) {
  vec2 d = vec2(uv.x, 1.0 - uv.y);         // top-down across the output
  vec2 f = uCrop.xy + d * uCrop.zw;        // top-down across the whole turned picture
  vec2 p = vec2(f.x - 0.5, 0.5 - f.y);     // centred, y up
  p.x *= uDevAspect;                       // -> square units, so angles are angles
  p = rot(p, uAngle);
  p *= uStretch;
  p /= max(0.05, uScale);
  p += uOffset;
  float w = 1.0 + uPersp.y * p.y + uPersp.x * p.x;
  p /= max(0.15, w);
  p.x /= max(0.001, uDevAspect);           // back to the unit square
  vec2 s = unTurn(p) + 0.5;
  s = mix(s, 1.0 - s, step(uFlip, vec2(0.0)));
  return s;
}

// Distortion is radial about the middle of the whole frame, because that is
// where a lens bends light from — not about the middle of whatever was cropped.
vec2 lensWarp(vec2 src, float k) {
  vec2 d = src - 0.5;
  float r2 = dot(d, d) * 4.0;
  return 0.5 + d * (1.0 + k * r2);
}

void main() {
  vec2 src = toSource(vUV);
  if (src.x < 0.0 || src.x > 1.0 || src.y < 0.0 || src.y > 1.0) { gl_FragColor = vec4(0.0); return; }

  float k = uDistort * 0.35;
  vec2 base = lensWarp(src, k);
  vec3 rgb;
  if (abs(uCA) > 0.001) {
    // Red and blue focus at slightly different distances, so undoing it is the
    // same warp at two more strengths — which is also how you fake it going the
    // other way when someone wants the look.
    float ca = uCA * 0.004;
    rgb.r = texture2D(uSrc, lensWarp(src, k + ca)).r;
    rgb.g = texture2D(uSrc, base).g;
    rgb.b = texture2D(uSrc, lensWarp(src, k - ca)).b;
  } else {
    rgb = texture2D(uSrc, base).rgb;
  }

  if (uLensVig > 0.001) {
    vec2 d = (src - 0.5) * 2.0;
    float r2 = dot(d, d);
    rgb *= 1.0 + uLensVig * 0.55 * r2 * r2;
  }
  gl_FragColor = vec4(rgb, 1.0);
}`;

// Pass two and three: a separable gaussian on a quarter-size copy. Clarity and
// dehaze both want to know "what does this picture look like with the detail
// taken out", and a quarter-size blur is indistinguishable from a full-size one
// at this radius while costing a sixteenth of the work.
const BLUR_FRAG = `
precision highp float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uStep;
void main() {
  vec4 sum = texture2D(uTex, vUV) * 0.2270270270;
  sum += (texture2D(uTex, vUV + uStep * 1.3846153846) + texture2D(uTex, vUV - uStep * 1.3846153846)) * 0.3162162162;
  sum += (texture2D(uTex, vUV + uStep * 3.2307692308) + texture2D(uTex, vUV - uStep * 3.2307692308)) * 0.0702702703;
  gl_FragColor = sum;
}`;

// Pass four: everything else, in the order Adobe runs it, because the order is
// most of why a set of numbers looks the way it does. White balance before
// exposure; tone before curve; curve before colour; grading after colour;
// detail, effects and local adjustments last.
const DEV_FRAG = `
precision highp float;
varying vec2 vUV;

uniform sampler2D uTex;      // the geometry pass
uniform sampler2D uBlur;     // the quarter-size blur
uniform sampler2D uCurve;    // 256x1: R,G,B channel curves, A the master curve
uniform sampler2D uBrush;    // four brush masks, one per channel
uniform vec2  uTexel;
uniform float uHasBrush;

uniform float uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks;
uniform float uTemp, uTint, uVibrance, uSaturation;
uniform float uTexture, uClarity, uDehaze, uBlurAmt;
uniform float uHasCurve;

uniform vec3 uHSL[8];        // hue shift, saturation, luminance per band
uniform float uHueCentre[8];
uniform float uHasMixer, uHasCalib;   // both are round trips through HSV, so they are skipped when flat

uniform vec4 uGradeS, uGradeM, uGradeH, uGradeG;   // rgb tint, then weight
uniform float uGradeBlend, uGradeBalance;

uniform float uSharpAmount, uSharpRadius, uSharpDetail, uSharpMask;
uniform float uNrLum, uNrDetail, uNrContrast, uNrColor, uNrColorDetail;

uniform float uVignette, uVignetteMid, uVignetteRound, uVignetteFeather, uVignetteHigh;
uniform float uGrain, uGrainSize, uGrainRough;
uniform float uAspect;

uniform float uCalShadow;
uniform vec2 uCalRed, uCalGreen, uCalBlue;   // hue, saturation

uniform int   uMaskCount;
uniform vec4  uMaskGeo[8];
uniform vec4  uMaskOpt[8];   // type, angle, feather, invert
uniform float uMaskAmt[8];
uniform vec4  uMaskA0[8];    // exposure, contrast, highlights, shadows
uniform vec4  uMaskA1[8];    // whites, blacks, temp, tint
uniform vec4  uMaskA2[8];    // saturation, clarity, dehaze, sharpness
uniform vec4  uMaskA3[8];    // blur, -, -, -
uniform float uShowMask;     // paint the mask red instead of using it

const float PI = 3.14159265359;

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float sat3(float x) { return clamp(x, 0.0, 1.0); }
vec3  sat3(vec3 c) { return clamp(c, 0.0, 1.0); }

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// A smoothstep either way round. Positive steepens the middle and rolls the
// ends off, negative does the reverse — both are monotone, so contrast never
// makes one tone darker than a tone below it.
float contrastS(float x, float t) {
  if (abs(t) < 0.001) return x;
  x = sat3(x);
  if (t > 0.0) return mix(x, x * x * (3.0 - 2.0 * x), t);
  return mix(x, 0.5 - sin(asin(1.0 - 2.0 * x) / 3.0), -t);
}

// Push one region of the range around, using only the headroom that is there:
// lifting can take what is above, pulling down can take what is below. Clipping
// is what separates a recovered highlight from a blown one.
float region(float x, float amt, float centre, float width) {
  if (abs(amt) < 0.0005) return x;
  float d = (x - centre) / width;
  float w = exp(-d * d);
  return x + amt * w * (amt > 0.0 ? (1.0 - x) : x);
}

vec3 applyTone(vec3 rgb, float exposure, float contrast, float high, float shad, float whites, float blacks) {
  vec3 lin = srgbToLinear(rgb) * exp2(exposure);
  rgb = linearToSrgb(lin);
  float L = lum(rgb);
  float t = L;
  t = region(t, shad * 0.6, 0.22, 0.26);
  t = region(t, high * 0.6, 0.78, 0.26);
  t = region(t, blacks * 0.5, 0.02, 0.18);
  t = region(t, whites * 0.5, 0.98, 0.18);
  t = contrastS(t, contrast);
  // Move the three channels by the same ratio the luminance moved, so tone
  // changes never shift the hue. The additive term keeps near-black usable,
  // where a pure ratio would explode.
  // Scaling the three channels by the ratio the luminance moved keeps the hue
  // exactly where it was. That breaks down near black, where the ratio explodes,
  // so down there the move is added on instead.
  float ratio = (L > 0.004) ? t / L : 1.0;
  return max(mix(rgb + (t - L), rgb * ratio, smoothstep(0.0, 0.06, L)), 0.0);
}

// Temperature and tint as a channel trade with the luminance put back, so the
// picture goes warmer rather than simply brighter.
vec3 whiteBalance(vec3 rgb, float temp, float tint) {
  if (abs(temp) < 0.001 && abs(tint) < 0.001) return rgb;
  vec3 lin = srgbToLinear(rgb);
  float before = max(1.0e-5, lum(lin));
  lin.r *= 1.0 + temp * 0.42;
  lin.b *= 1.0 - temp * 0.42;
  lin.g *= 1.0 - tint * 0.30;
  lin.r *= 1.0 + tint * 0.12;
  lin.b *= 1.0 + tint * 0.12;
  lin *= before / max(1.0e-5, lum(lin));
  return linearToSrgb(max(lin, 0.0));
}

vec3 applySaturation(vec3 rgb, float vibrance, float saturation) {
  float L = lum(rgb);
  if (abs(saturation) > 0.001) {
    rgb = mix(vec3(L), rgb, 1.0 + saturation);
  }
  if (abs(vibrance) > 0.001) {
    // The less saturated a colour already is, the more of the slider it gets —
    // which is why vibrance leaves skin alone and lifts a dull sky.
    float s = length(rgb - vec3(L)) * 1.4;
    float weight = 1.0 - clamp(s, 0.0, 1.0);
    rgb = mix(vec3(L), rgb, 1.0 + vibrance * (0.35 + 0.85 * weight));
  }
  return max(rgb, 0.0);
}

// How much a pixel belongs to one of the eight bands. The falloff overlaps its
// neighbours, so a colour sitting between orange and yellow is moved by both
// and never jumps from one to the other.
float bandWeight(float hueDeg, float centre) {
  float d = abs(hueDeg - centre);
  d = min(d, 360.0 - d);
  return 1.0 - smoothstep(0.0, 42.0, d);
}

vec3 applyMixer(vec3 rgb) {
  vec3 hsv = rgb2hsv(sat3(rgb));
  if (hsv.y < 0.004) return rgb;               // grey has no hue to move
  float hueDeg = hsv.x * 360.0;
  float dh = 0.0, ds = 0.0, dl = 0.0, total = 0.0;
  for (int i = 0; i < 8; i++) {
    float w = bandWeight(hueDeg, uHueCentre[i]);
    if (w <= 0.0) continue;
    dh += uHSL[i].x * w;
    ds += uHSL[i].y * w;
    dl += uHSL[i].z * w;
    total += w;
  }
  if (total <= 0.0) return rgb;
  dh /= total; ds /= total; dl /= total;
  hsv.x = fract(hsv.x + dh * 0.08);
  hsv.y = clamp(hsv.y * (1.0 + ds), 0.0, 1.0);
  vec3 out3 = hsv2rgb(hsv);
  if (abs(dl) > 0.001) out3 *= 1.0 + dl * 0.55;
  return max(out3, 0.0);
}

// Three wheels weighted by how bright the pixel is, with balance sliding where
// the split falls and blending deciding how far each zone bleeds into the next.
vec3 applyGrading(vec3 rgb) {
  float L = sat3(lum(rgb));
  float balance = uGradeBalance * 0.35;
  float soft = mix(0.12, 0.55, uGradeBlend);
  float wS = 1.0 - smoothstep(0.0, 0.5 + soft + balance, L);
  float wH = smoothstep(0.5 - soft + balance, 1.0, L);
  float wM = max(0.0, 1.0 - wS - wH);

  vec3 tint = uGradeS.rgb * uGradeS.a * wS
            + uGradeM.rgb * uGradeM.a * wM
            + uGradeH.rgb * uGradeH.a * wH
            + uGradeG.rgb * uGradeG.a;
  float weight = uGradeS.a * wS + uGradeM.a * wM + uGradeH.a * wH + uGradeG.a;
  if (weight <= 0.0001) return rgb;
  // Soft light rather than a straight mix: the tint colours the picture without
  // flattening it into a wash.
  vec3 blend = mix(2.0 * rgb * tint, 1.0 - 2.0 * (1.0 - rgb) * (1.0 - tint), step(0.5, rgb));
  return mix(rgb, sat3(blend), clamp(weight, 0.0, 1.0));
}

// Calibration moves the three primaries themselves, which is a blunter and
// more far-reaching thing than the mixer — it is what gives a whole profile its
// character rather than correcting one colour.
vec3 applyCalibration(vec3 rgb) {
  vec3 amounts = rgb;
  vec3 result = vec3(0.0);
  vec3 hues = vec3(0.0, 120.0, 240.0) + vec3(uCalRed.x, uCalGreen.x, uCalBlue.x) * 30.0;
  vec3 sats = vec3(1.0) + vec3(uCalRed.y, uCalGreen.y, uCalBlue.y);
  for (int i = 0; i < 3; i++) {
    float a = amounts[i];
    vec3 primary = hsv2rgb(vec3(fract(hues[i] / 360.0), clamp(sats[i], 0.0, 1.0), 1.0));
    result += a * primary;
  }
  if (abs(uCalShadow) > 0.001) {
    float w = 1.0 - smoothstep(0.0, 0.5, lum(rgb));
    result.g -= uCalShadow * 0.09 * w;
    result.r += uCalShadow * 0.045 * w;
    result.b += uCalShadow * 0.045 * w;
  }
  return max(result, 0.0);
}

/* ------------------------------ masks ------------------------------------- */

// Masks are placed by dragging handles over the picture, so their coordinates
// are the ones the UI uses: 0,0 top left. mUV is vUV turned the same way up.
vec2 maskUV() { return vec2(vUV.x, 1.0 - vUV.y); }

float radialMask(vec4 geo, float angle, float feather) {
  vec2 p = maskUV() - geo.xy;
  p.x *= uAspect;
  float s = sin(-angle), c = cos(-angle);
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  float d = length(p / max(vec2(0.002), geo.zw * vec2(uAspect, 1.0)));
  return 1.0 - smoothstep(1.0 - clamp(feather, 0.02, 1.0), 1.0, d);
}

float linearMask(vec4 geo) {
  vec2 a = geo.xy, b = geo.zw;
  vec2 dir = b - a;
  float len2 = max(1.0e-5, dot(dir, dir));
  float t = dot(maskUV() - a, dir) / len2;
  return 1.0 - clamp(t, 0.0, 1.0);
}

float brushMask(float slot) {
  if (uHasBrush < 0.5) return 0.0;
  vec4 slots = texture2D(uBrush, maskUV());
  if (slot < 0.5) return slots.r;
  if (slot < 1.5) return slots.g;
  if (slot < 2.5) return slots.b;
  return slots.a;
}

float maskWeight(vec4 geo, vec4 opt) {
  float m;
  if (opt.x < 0.5) m = radialMask(geo, opt.y, opt.z);
  else if (opt.x < 1.5) m = linearMask(geo);
  else m = brushMask(geo.x);
  if (opt.w > 0.5) m = 1.0 - m;
  return clamp(m, 0.0, 1.0);
}

/* ----------------------------- local contrast ----------------------------- */

// Unsharp masking against the blurred copy. Positive adds the detail back with
// interest; negative takes it away, which is what "smooth the skin" means.
vec3 localContrast(vec3 rgb, vec3 blurred, vec3 fine, float clarity, float texture, float dehaze) {
  if (abs(clarity) > 0.001) {
    float detail = lum(rgb) - lum(blurred);
    // Backed off at both ends of the range, so clarity does not punch holes in
    // a sky or crush what is already nearly black.
    float room = 1.0 - abs(lum(rgb) - 0.5) * 1.4;
    rgb += detail * clarity * 1.5 * max(0.15, room);
  }
  if (abs(texture) > 0.001) {
    float detail = lum(rgb) - lum(fine);
    rgb += detail * texture * 2.2;
  }
  if (dehaze > 0.001) {
    // Haze is whatever flat grey sits under the whole frame, and the darkest
    // channel of the blurred copy is a fair guess at it. Take it out, then put
    // back the colour that removing it costs.
    float haze = min(min(blurred.r, blurred.g), blurred.b) * dehaze * 0.85;
    rgb = (rgb - haze) / max(0.15, 1.0 - haze);
    float L = lum(rgb);
    rgb = mix(vec3(L), rgb, 1.0 + dehaze * 0.3);
  } else if (dehaze < -0.001) {
    // The other way: pull everything toward the blurred average and lift the
    // floor, which is what mist in front of a scene actually does to it.
    rgb = mix(rgb, blurred, -dehaze * 0.35);
    rgb = mix(rgb, rgb * 0.80 + 0.20, -dehaze * 0.55);
    float L = lum(rgb);
    rgb = mix(vec3(L), rgb, 1.0 + dehaze * 0.25);
  }
  return max(rgb, 0.0);
}

void main() {
  vec4 base = texture2D(uTex, vUV);
  if (base.a < 0.01) { gl_FragColor = vec4(0.0); return; }
  vec3 rgb = base.rgb;

  /* ---- neighbours, gathered once and reused by detail and presence ---- */
  float r = max(0.5, uSharpRadius);
  vec2 o = uTexel * r;
  vec3 n = texture2D(uTex, vUV + vec2(0.0, -o.y)).rgb;
  vec3 s = texture2D(uTex, vUV + vec2(0.0,  o.y)).rgb;
  vec3 w = texture2D(uTex, vUV + vec2(-o.x, 0.0)).rgb;
  vec3 e = texture2D(uTex, vUV + vec2( o.x, 0.0)).rgb;
  vec3 nw = texture2D(uTex, vUV + vec2(-o.x, -o.y)).rgb;
  vec3 ne = texture2D(uTex, vUV + vec2( o.x, -o.y)).rgb;
  vec3 sw = texture2D(uTex, vUV + vec2(-o.x,  o.y)).rgb;
  vec3 se = texture2D(uTex, vUV + vec2( o.x,  o.y)).rgb;
  vec3 fine = (rgb * 4.0 + (n + s + w + e) * 2.0 + nw + ne + sw + se) / 16.0;
  vec3 blurred = texture2D(uBlur, vUV).rgb;

  /* ---- noise reduction, before anything amplifies the noise ---- */
  if (uNrLum > 0.001) {
    // Keep the edges: a neighbour that is a long way off in tone is a different
    // thing, not noise, so it gets less of a vote.
    float centre = lum(rgb);
    float keep = mix(0.02, 0.30, 1.0 - uNrDetail);
    float total = 1.0;
    vec3 acc = rgb;
    vec3 nb[8];
    nb[0] = n; nb[1] = s; nb[2] = w; nb[3] = e; nb[4] = nw; nb[5] = ne; nb[6] = sw; nb[7] = se;
    for (int i = 0; i < 8; i++) {
      float wgt = exp(-pow((lum(nb[i]) - centre) / keep, 2.0));
      acc += nb[i] * wgt; total += wgt;
    }
    vec3 smoothed = acc / total;
    // NR contrast puts some of the micro-contrast back that smoothing ate.
    smoothed = mix(smoothed, smoothed + (rgb - smoothed) * 0.55, uNrContrast);
    rgb = mix(rgb, smoothed, uNrLum);
  }
  if (uNrColor > 0.001) {
    // Colour speckle is chroma-only, so blur the colour and keep the luminance
    // exactly as it was — the picture stays sharp, the confetti goes.
    vec3 chromaBlur = (rgb + n + s + w + e + nw + ne + sw + se) / 9.0;
    float keepDetail = mix(1.0, 0.35, uNrColorDetail);
    vec3 mixed = mix(chromaBlur, rgb, keepDetail * 0.5);
    float L = lum(rgb);
    vec3 chroma = mixed - vec3(lum(mixed));
    rgb = mix(rgb, vec3(L) + chroma, uNrColor);
  }

  /* ---- white balance, exposure, tone ---- */
  rgb = whiteBalance(rgb, uTemp, uTint);
  rgb = applyTone(rgb, uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks);

  /* ---- presence ---- */
  rgb = localContrast(rgb, blurred, fine, uClarity, uTexture, uDehaze);

  /* ---- tone curve: master first, then per channel ---- */
  if (uHasCurve > 0.5) {
    rgb = sat3(rgb);
    rgb = vec3(
      texture2D(uCurve, vec2(rgb.r, 0.5)).a,
      texture2D(uCurve, vec2(rgb.g, 0.5)).a,
      texture2D(uCurve, vec2(rgb.b, 0.5)).a
    );
    rgb = vec3(
      texture2D(uCurve, vec2(rgb.r, 0.5)).r,
      texture2D(uCurve, vec2(rgb.g, 0.5)).g,
      texture2D(uCurve, vec2(rgb.b, 0.5)).b
    );
  }

  /* ---- colour ---- */
  if (uHasCalib > 0.5) rgb = applyCalibration(rgb);
  if (uHasMixer > 0.5) rgb = applyMixer(rgb);
  rgb = applySaturation(rgb, uVibrance, uSaturation);
  rgb = applyGrading(sat3(rgb));

  /* ---- sharpening, worked out on the original detail ---- */
  if (uSharpAmount > 0.001) {
    float detail = lum(rgb) - lum(fine);
    // Masking: only where something is actually happening. Flat sky keeps its
    // noise instead of having it sharpened into grit.
    float edge = length(vec2(lum(e) - lum(w), lum(s) - lum(n))) * 8.0;
    float gate = mix(1.0, smoothstep(0.0, 1.0, edge), uSharpMask);
    // Detail decides how much of the halo suppression to let through.
    float halo = mix(0.55, 1.0, uSharpDetail);
    rgb += detail * uSharpAmount * gate * halo;
  }

  /* ---- local adjustments ---- */
  float shown = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uMaskCount) break;
    float m = maskWeight(uMaskGeo[i], uMaskOpt[i]) * uMaskAmt[i];
    if (m <= 0.002) continue;
    shown = max(shown, m);
    vec4 a0 = uMaskA0[i], a1 = uMaskA1[i], a2 = uMaskA2[i], a3 = uMaskA3[i];
    vec3 local = rgb;
    local = whiteBalance(local, a1.z, a1.w);
    local = applyTone(local, a0.x, a0.y, a0.z, a0.w, a1.x, a1.y);
    local = localContrast(local, blurred, fine, a2.y, 0.0, a2.z);
    if (abs(a2.x) > 0.001) { float L = lum(local); local = mix(vec3(L), local, 1.0 + a2.x); }
    if (a2.w > 0.001) local += (lum(local) - lum(fine)) * a2.w * 1.6;
    if (a3.x > 0.001) local = mix(local, blurred, a3.x);
    rgb = mix(rgb, max(local, 0.0), m);
  }

  /* ---- effects ---- */
  if (abs(uVignette) > 0.001) {
    vec2 d = (vUV - 0.5) * 2.0;
    // Roundness slides between following the frame and being a true circle.
    d.x *= mix(uAspect, 1.0, clamp(uVignetteRound * 0.5 + 0.5, 0.0, 1.0));
    float dist = length(d) / max(0.05, uVignetteMid * 2.0);
    float feather = mix(0.05, 1.2, uVignetteFeather);
    float v = smoothstep(1.0 - feather, 1.0 + feather * 0.4, dist);
    // Highlights protection: a bright thing in the corner keeps its brightness
    // while everything around it goes down.
    v *= mix(1.0, 1.0 - smoothstep(0.5, 1.0, lum(rgb)), uVignetteHigh);
    rgb *= 1.0 + uVignette * v * (uVignette > 0.0 ? 0.9 : 1.0);
  }
  if (uGrain > 0.001) {
    float scale = mix(420.0, 80.0, uGrainSize);
    vec2 gp = floor(vUV * scale);
    float nA = fract(sin(dot(gp, vec2(12.9898, 78.233))) * 43758.5453);
    float nB = fract(sin(dot(gp * 1.7 + 4.3, vec2(39.3468, 11.135))) * 24634.6345);
    // Roughness mixes a second, coarser grain in, which is what makes fast film
    // look clumpy rather than evenly speckled.
    float g = mix(nA, nA * nB * 1.6, uGrainRough) - 0.5;
    // Grain shows in the midtones and all but vanishes in the deepest black.
    float room = 1.0 - abs(lum(rgb) - 0.45) * 1.2;
    rgb += g * uGrain * 0.42 * max(0.1, room);
  }

  if (uShowMask > 0.5) {
    rgb = mix(rgb * 0.55, vec3(0.85, 0.25, 0.25), shown * 0.65);
  }
  if (uBlurAmt > 0.001) rgb = mix(rgb, blurred, clamp(uBlurAmt, 0.0, 1.0));

  gl_FragColor = vec4(sat3(rgb), 1.0);
}`;

/* ------------------------------- the context ------------------------------ */

let GL = null;          // { gl, canvas, programs, buffers, ... }
let unavailable = false;
// Kept rather than thrown away: a shader that will not compile on somebody's
// phone is the kind of thing you only find out about if the reason survives.
export let rendererError = null;

export function rendererAvailable() {
  if (unavailable) return false;
  if (GL) return true;
  try {
    return !!setup();
  } catch (err) {
    unavailable = true;
    rendererError = err;
    if (typeof console !== "undefined") console.warn("[photoRender]", err && err.message);
    return false;
  }
}

function setup() {
  if (GL) return GL;
  if (unavailable || typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  const opts = { alpha: true, premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true, depth: false, stencil: false };
  const gl = canvas.getContext("webgl2", opts) || canvas.getContext("webgl", opts);
  if (!gl) { unavailable = true; return null; }

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  GL = {
    gl, canvas, quad,
    geom: program(gl, VERT, GEOM_FRAG),
    blur: program(gl, VERT, BLUR_FRAG),
    dev: program(gl, VERT, DEV_FRAG),
    srcTex: texture(gl),
    curveTex: texture(gl),
    brushTex: texture(gl),
    targets: {},
    lut: new Uint8Array(256 * 4),
    master: new Float32Array(256),
    scratch: new Float32Array(256),
    brushCanvas: null,
  };

  // A lost context is recoverable: drop everything and rebuild on the next
  // frame rather than leaving every picture on the board blank.
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); GL = null; }, false);
  return GL;
}

function program(gl, vsrc, fsrc) {
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || "shader failed to compile");
    }
    return sh;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vsrc));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsrc));
  gl.bindAttribLocation(p, 0, "aPos");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p) || "program failed to link");
  }
  // Uniform locations are looked up once and cached: fetching them by name on
  // every frame is one of the few genuinely slow calls in WebGL.
  const loc = {};
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, "");
    loc[name] = gl.getUniformLocation(p, name);
  }
  return { p, loc };
}

function texture(gl) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return t;
}

// Render targets are kept and resized rather than recreated, because a board
// redrawing fifty photos would otherwise churn fifty framebuffers a frame.
function target(name, w, h) {
  const { gl, targets } = GL;
  let t = targets[name];
  if (!t) {
    t = targets[name] = { fb: gl.createFramebuffer(), tex: texture(gl), w: 0, h: 0 };
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
  }
  if (t.w !== w || t.h !== h) {
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    t.w = w; t.h = h;
  }
  return t;
}

function draw(prog, w, h, fb) {
  const { gl, quad } = GL;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb || null);
  gl.viewport(0, 0, w, h);
  gl.useProgram(prog.p);
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

const bind = (unit, tex, loc) => {
  const { gl } = GL;
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  if (loc) gl.uniform1i(loc, unit);
};

/* --------------------------- what comes out of it ------------------------- */

// The picture's shape after turning and cropping — in that order — which
// callers need before a frame exists so they can size the canvas they are about
// to hand us.
export const turnedAspect = (imageW, imageH, edit) => {
  const quarters = Math.round((((edit && edit.spin) || 0) % 360) / 90);
  return ((quarters % 2 + 2) % 2) ? imageH / imageW : imageW / imageH;
};

export function outputAspect(imageW, imageH, crop, edit) {
  const dev = turnedAspect(imageW, imageH, edit);
  const cw = crop ? crop.w : 1, ch = crop ? crop.h : 1;
  return (ch > 0 ? (cw / ch) * dev : dev) || 1;
}

const rad = (deg) => (deg * Math.PI) / 180;

// A hue/saturation pair off a grading wheel, as a colour the shader can mix in.
function wheelColour(g) {
  if (!g || !g.s) return [0, 0, 0, 0];
  const h = ((g.h % 360) + 360) / 360;
  const s = Math.min(1, Math.abs(g.s) / 100);
  // hsv -> rgb, at full value: the wheel picks a hue and how strongly it lands,
  // and luminance is a separate lift applied through the weight.
  const k = (n) => (n + h * 6) % 6;
  const f = (n) => 1 - s * Math.max(0, Math.min(Math.min(k(n), 4 - k(n)), 1));
  const lift = 1 + (g.l || 0) / 200;
  return [f(5) * lift, f(3) * lift, f(1) * lift, s * 0.85];
}

function buildCurveTexture(edit) {
  const { gl, lut, master, scratch } = GL;
  const flatPoints = isFlatCurve(edit.curveRGB) && isFlatCurve(edit.curveR)
    && isFlatCurve(edit.curveG) && isFlatCurve(edit.curveB);
  const flatParam = !edit.parHighlights && !edit.parLights && !edit.parDarks && !edit.parShadows;
  if (flatPoints && flatParam) return false;

  // The parametric curve and the master point curve are two ways of bending the
  // same thing, so they are composed into one lookup rather than costing two
  // texture reads per channel.
  parametricLUT(edit, master);
  if (!isFlatCurve(edit.curveRGB)) {
    curveLUT(edit.curveRGB, scratch);
    for (let i = 0; i < 256; i++) master[i] = scratch[Math.round(master[i] * 255)];
  }
  const channels = [edit.curveR, edit.curveG, edit.curveB];
  for (let c = 0; c < 3; c++) {
    curveLUT(channels[c], scratch);
    for (let i = 0; i < 256; i++) lut[i * 4 + c] = Math.round(scratch[i] * 255);
  }
  for (let i = 0; i < 256; i++) lut[i * 4 + 3] = Math.round(master[i] * 255);

  gl.bindTexture(gl.TEXTURE_2D, GL.curveTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
  return true;
}

// Brush strokes are painted into the four channels of one texture rather than
// solved in the shader: a mask can hold hundreds of dabs, and a loop that long
// per pixel would bring any GPU to its knees.
function buildBrushTexture(masks, aspect) {
  const brushMasks = masks.filter((m) => m.type === "brush" && (m.strokes || []).length);
  if (!brushMasks.length) return false;
  const { gl } = GL;
  const size = 512;
  if (!GL.brushCanvas) {
    GL.brushCanvas = document.createElement("canvas");
    GL.brushCanvas.width = size; GL.brushCanvas.height = size;
    GL.brushBytes = new Uint8Array(size * size * 4);
  }
  const layer = GL.brushCanvas;
  const lctx = layer.getContext("2d", { willReadFrequently: true });
  const bytes = GL.brushBytes;
  bytes.fill(0);

  brushMasks.forEach((mask, index) => {
    if (index >= MAX_BRUSH_SLOTS) return;
    lctx.clearRect(0, 0, size, size);
    lctx.globalCompositeOperation = "source-over";
    for (const stroke of mask.strokes) {
      // The mask sheet is square but the picture rarely is, so a dab drawn as a
      // circle here would land on the photo as an ellipse. Stretch it the other
      // way by the same amount and a round brush stays round.
      const rx = Math.max(2, (stroke.r || mask.brushSize) * size);
      const ry = Math.max(2, rx * aspect);
      const x = stroke.x * size, y = stroke.y * size;
      lctx.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
      const feather = Math.max(0.02, (mask.brushFeather ?? 50) / 100);
      const alpha = Math.max(0.05, (stroke.flow ?? mask.brushFlow ?? 100) / 100);
      lctx.save();
      lctx.translate(x, y);
      lctx.scale(1, ry / rx);
      const grad = lctx.createRadialGradient(0, 0, rx * (1 - feather), 0, 0, rx);
      grad.addColorStop(0, `rgba(255,255,255,${alpha})`);
      grad.addColorStop(1, "rgba(255,255,255,0)");
      lctx.fillStyle = grad;
      lctx.beginPath();
      lctx.arc(0, 0, rx, 0, Math.PI * 2);
      lctx.fill();
      lctx.restore();
    }
    const px = lctx.getImageData(0, 0, size, size).data;
    for (let i = 0; i < size * size; i++) bytes[i * 4 + index] = px[i * 4 + 3];
  });

  // Straight to the GPU as bytes rather than back through a canvas. A canvas
  // holds its pixels premultiplied, and slot four lives in the alpha channel —
  // so a round trip would wipe the other three wherever nothing was painted.
  gl.bindTexture(gl.TEXTURE_2D, GL.brushTex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  // Not flipped, unlike the photo: the shader reads this sheet with the mask
  // coordinates, which run from the top down the way the handles do.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  return true;
}

/* -------------------------------- rendering ------------------------------- */

/**
 * Develop one picture.
 *
 * `image` is anything drawable — an <img>, a canvas, an ImageBitmap. The result
 * is left on the shared GL canvas and copied into `out` (a 2D canvas) so the
 * caller owns a stable bitmap that survives the next photo being rendered.
 * Returns false if WebGL could not do it, which is the caller's cue to fall
 * back to the CSS approximation.
 */
export function renderPhoto({ image, look, crop, out, maxSize = 1600, showMask = false, preview = null }) {
  const ctx = setup();
  if (!ctx) return false;
  const { gl } = ctx;
  const edit = preview || fullEdit(look);

  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  if (!iw || !ih) return false;

  const c = crop || { x: 0, y: 0, w: 1, h: 1 };
  const aspect = outputAspect(iw, ih, crop, edit);
  const devAspect = turnedAspect(iw, ih, edit);
  // Size from the long edge. A quarter turn swaps which edge that is, so asking
  // for "the crop's width" would render the picture at the wrong resolution
  // rather than merely the wrong shape.
  const turned = devAspect !== iw / ih;
  const devW = turned ? ih : iw, devH = turned ? iw : ih;
  const longEdge = Math.min(maxSize, Math.max(32, Math.max(c.w * devW, c.h * devH)));
  const w = Math.max(8, Math.round(aspect >= 1 ? longEdge : longEdge * aspect));
  const h = Math.max(8, Math.round(aspect >= 1 ? longEdge / aspect : longEdge));

  if (ctx.canvas.width !== w || ctx.canvas.height !== h) {
    ctx.canvas.width = w; ctx.canvas.height = h;
  }

  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.bindTexture(gl.TEXTURE_2D, ctx.srcTex);
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  } catch {
    return false;                       // a picture that has not finished loading
  }

  /* ---- pass one: geometry ---- */
  const geo = target("geo", w, h);
  const g = ctx.geom;
  gl.useProgram(g.p);
  bind(0, ctx.srcTex, g.loc.uSrc);
  gl.uniform4f(g.loc.uCrop, c.x, c.y, c.w, c.h);
  gl.uniform1f(g.loc.uDevAspect, devAspect);
  gl.uniform1f(g.loc.uAngle, rad(edit.straighten + edit.perspRotate));
  gl.uniform1f(g.loc.uSpinSteps, (Math.round((edit.spin || 0) / 90) % 4 + 4) % 4);
  gl.uniform2f(g.loc.uFlip, edit.flipH ? -1 : 1, edit.flipV ? -1 : 1);
  gl.uniform2f(g.loc.uPersp, edit.perspH * 0.004, edit.perspV * 0.004);
  gl.uniform2f(g.loc.uStretch, 1 - edit.geoAspect * 0.003, 1 + edit.geoAspect * 0.003);
  gl.uniform1f(g.loc.uScale, edit.geoScale / 100);
  gl.uniform2f(g.loc.uOffset, edit.geoX * 0.004, edit.geoY * 0.004);
  gl.uniform1f(g.loc.uDistort, edit.distortion / 100);
  gl.uniform1f(g.loc.uCA, edit.caAmount / 100);
  gl.uniform1f(g.loc.uLensVig, edit.lensVignette / 100);
  draw(g, w, h, geo.fb);

  /* ---- passes two and three: the blurred copy ---- */
  const bw = Math.max(4, w >> 2), bh = Math.max(4, h >> 2);
  const tmp = target("blurA", bw, bh);
  const blur = target("blurB", bw, bh);
  const b = ctx.blur;
  gl.useProgram(b.p);
  bind(0, geo.tex, b.loc.uTex);
  gl.uniform2f(b.loc.uStep, 1 / bw, 0);
  draw(b, bw, bh, tmp.fb);
  gl.useProgram(b.p);
  bind(0, tmp.tex, b.loc.uTex);
  gl.uniform2f(b.loc.uStep, 0, 1 / bh);
  draw(b, bw, bh, blur.fb);

  /* ---- pass four: everything else ---- */
  const d = ctx.dev;
  gl.useProgram(d.p);
  bind(0, geo.tex, d.loc.uTex);
  bind(1, blur.tex, d.loc.uBlur);

  const hasCurve = buildCurveTexture(edit);
  bind(2, ctx.curveTex, d.loc.uCurve);
  gl.uniform1f(d.loc.uHasCurve, hasCurve ? 1 : 0);

  const masks = (edit.masks || []).filter((m) => !m.hidden).slice(0, MAX_MASKS);
  const hasBrush = buildBrushTexture(masks, aspect);
  bind(3, ctx.brushTex, d.loc.uBrush);
  gl.uniform1f(d.loc.uHasBrush, hasBrush ? 1 : 0);

  gl.uniform2f(d.loc.uTexel, 1 / w, 1 / h);
  gl.uniform1f(d.loc.uAspect, aspect);

  gl.uniform1f(d.loc.uExposure, edit.exposure);
  gl.uniform1f(d.loc.uContrast, edit.contrast / 100);
  gl.uniform1f(d.loc.uHighlights, edit.highlights / 100);
  gl.uniform1f(d.loc.uShadows, edit.shadows / 100);
  gl.uniform1f(d.loc.uWhites, edit.whites / 100);
  gl.uniform1f(d.loc.uBlacks, edit.blacks / 100);
  gl.uniform1f(d.loc.uTemp, edit.temp / 100);
  gl.uniform1f(d.loc.uTint, edit.tint / 100);
  gl.uniform1f(d.loc.uVibrance, edit.vibrance / 100);
  gl.uniform1f(d.loc.uSaturation, edit.saturation / 100);
  gl.uniform1f(d.loc.uTexture, edit.texture / 100);
  gl.uniform1f(d.loc.uClarity, edit.clarity / 100);
  gl.uniform1f(d.loc.uDehaze, edit.dehaze / 100);
  gl.uniform1f(d.loc.uBlurAmt, edit.blur / 12);

  const hsl = new Float32Array(24), centres = new Float32Array(8);
  HSL_BANDS.forEach((band, i) => {
    const v = edit.hsl[band.id] || { h: 0, s: 0, l: 0 };
    hsl[i * 3] = v.h / 100; hsl[i * 3 + 1] = v.s / 100; hsl[i * 3 + 2] = v.l / 100;
    centres[i] = band.hue;
  });
  gl.uniform3fv(d.loc.uHSL, hsl);
  gl.uniform1fv(d.loc.uHueCentre, centres);
  gl.uniform1f(d.loc.uHasMixer, hsl.some((v) => v !== 0) ? 1 : 0);
  gl.uniform1f(d.loc.uHasCalib, (edit.calShadow || edit.calRedH || edit.calRedS
    || edit.calGreenH || edit.calGreenS || edit.calBlueH || edit.calBlueS) ? 1 : 0);

  gl.uniform4fv(d.loc.uGradeS, wheelColour(edit.gradeShadow));
  gl.uniform4fv(d.loc.uGradeM, wheelColour(edit.gradeMid));
  gl.uniform4fv(d.loc.uGradeH, wheelColour(edit.gradeHigh));
  gl.uniform4fv(d.loc.uGradeG, wheelColour(edit.gradeGlobal));
  gl.uniform1f(d.loc.uGradeBlend, edit.gradeBlend / 100);
  gl.uniform1f(d.loc.uGradeBalance, edit.gradeBalance / 100);

  gl.uniform1f(d.loc.uSharpAmount, edit.sharpAmount / 100);
  gl.uniform1f(d.loc.uSharpRadius, edit.sharpRadius);
  gl.uniform1f(d.loc.uSharpDetail, edit.sharpDetail / 100);
  gl.uniform1f(d.loc.uSharpMask, edit.sharpMask / 100);
  gl.uniform1f(d.loc.uNrLum, edit.nrLuminance / 100);
  gl.uniform1f(d.loc.uNrDetail, edit.nrDetail / 100);
  gl.uniform1f(d.loc.uNrContrast, edit.nrContrast / 100);
  gl.uniform1f(d.loc.uNrColor, edit.nrColor / 100);
  gl.uniform1f(d.loc.uNrColorDetail, edit.nrColorDetail / 100);

  gl.uniform1f(d.loc.uVignette, edit.vignette / 100);
  gl.uniform1f(d.loc.uVignetteMid, edit.vignetteMid / 100);
  gl.uniform1f(d.loc.uVignetteRound, edit.vignetteRound / 100);
  gl.uniform1f(d.loc.uVignetteFeather, edit.vignetteFeather / 100);
  gl.uniform1f(d.loc.uVignetteHigh, edit.vignetteHigh / 100);
  gl.uniform1f(d.loc.uGrain, edit.grain / 100);
  gl.uniform1f(d.loc.uGrainSize, edit.grainSize / 100);
  gl.uniform1f(d.loc.uGrainRough, edit.grainRough / 100);

  gl.uniform1f(d.loc.uCalShadow, edit.calShadow / 100);
  gl.uniform2f(d.loc.uCalRed, edit.calRedH / 100, edit.calRedS / 100);
  gl.uniform2f(d.loc.uCalGreen, edit.calGreenH / 100, edit.calGreenS / 100);
  gl.uniform2f(d.loc.uCalBlue, edit.calBlueH / 100, edit.calBlueS / 100);

  const geoArr = new Float32Array(MAX_MASKS * 4);
  const optArr = new Float32Array(MAX_MASKS * 4);
  const amtArr = new Float32Array(MAX_MASKS);
  const a0 = new Float32Array(MAX_MASKS * 4), a1 = new Float32Array(MAX_MASKS * 4);
  const a2 = new Float32Array(MAX_MASKS * 4), a3 = new Float32Array(MAX_MASKS * 4);
  let brushSlot = 0;
  masks.forEach((m, i) => {
    const type = m.type === "linear" ? 1 : m.type === "brush" ? 2 : 0;
    if (type === 0) geoArr.set([m.cx, m.cy, m.rx, m.ry], i * 4);
    else if (type === 1) geoArr.set([m.x1, m.y1, m.x2, m.y2], i * 4);
    else geoArr.set([brushSlot++, 0, 0, 0], i * 4);
    optArr.set([type, rad(m.angle || 0), (m.feather ?? 50) / 100, m.invert ? 1 : 0], i * 4);
    amtArr[i] = (m.amount ?? 100) / 100;
    const a = m.adjust || {};
    a0.set([a.exposure || 0, (a.contrast || 0) / 100, (a.highlights || 0) / 100, (a.shadows || 0) / 100], i * 4);
    a1.set([(a.whites || 0) / 100, (a.blacks || 0) / 100, (a.temp || 0) / 100, (a.tint || 0) / 100], i * 4);
    a2.set([(a.saturation || 0) / 100, (a.clarity || 0) / 100, (a.dehaze || 0) / 100, (a.sharpness || 0) / 100], i * 4);
    a3.set([(a.blur || 0) / 100, 0, 0, 0], i * 4);
  });
  gl.uniform1i(d.loc.uMaskCount, masks.length);
  gl.uniform4fv(d.loc.uMaskGeo, geoArr);
  gl.uniform4fv(d.loc.uMaskOpt, optArr);
  gl.uniform1fv(d.loc.uMaskAmt, amtArr);
  gl.uniform4fv(d.loc.uMaskA0, a0);
  gl.uniform4fv(d.loc.uMaskA1, a1);
  gl.uniform4fv(d.loc.uMaskA2, a2);
  gl.uniform4fv(d.loc.uMaskA3, a3);
  gl.uniform1f(d.loc.uShowMask, showMask ? 1 : 0);

  draw(d, w, h, null);

  if (out) {
    if (out.width !== w || out.height !== h) { out.width = w; out.height = h; }
    const o = out.getContext("2d");
    o.clearRect(0, 0, w, h);
    o.drawImage(ctx.canvas, 0, 0);
  }
  return { width: w, height: h };
}

// A finished frame as a file, for "save a copy to Drive". Done on a throwaway
// canvas so the caller's on-screen one is not disturbed.
export function renderToBlob({ image, look, crop, maxSize = 2400, type = "image/jpeg", quality = 0.92 }) {
  const out = document.createElement("canvas");
  const ok = renderPhoto({ image, look, crop, out, maxSize });
  if (!ok) return Promise.resolve(null);
  return new Promise((resolve) => out.toBlob(resolve, type, quality));
}

// The pixels behind the cursor, for the eyedropper and the histogram, read back
// from a small render rather than the on-screen canvas so it works at any zoom.
export function sampleCanvas(canvas, x, y) {
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const px = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return { r: px[0], g: px[1], b: px[2] };
  } catch { return null; }
}
