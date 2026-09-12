/* --------------------------------------------------------------------------
 * What was behind it, guessed.
 *
 * Everything in photoHeal.js copies: whatever ends up in the hole was already
 * somewhere else in the same photograph. That is its strength on a bin against
 * a hedge and its hard limit on anything else — remove a child from a lawn and
 * there is no spare lawn with nothing on it to copy from, so the fill has to
 * borrow grass from wherever the light happened to be different, and the eye
 * catches it.
 *
 * This is the other half: a small network that has seen a great many
 * photographs and will say what ought to be behind something, rather than
 * hunting for it. MI-GAN (Picsart, ICCV 2023) — chosen over the better-known
 * LaMa because it was built to run on a phone, which is the same constraint as
 * running in a browser tab: 27MB of weights against LaMa's couple of hundred,
 * and MIT licensed, which LaMa's weights are not.
 *
 * It is not used on its own. The network decides *what* is behind the thing;
 * photoHeal still decides *which actual pixels*, by matching against the
 * photograph at its own resolution. A network asked to paint a 4000px hole
 * gives back something soft and slightly invented-looking; asked only for the
 * structure, with real camera grain copied over the top of it, it gives back
 * something that reads as the photograph. That division is the whole idea of
 * Guided PatchMatch (2022), and it is why this file is small.
 *
 * Everything runs on the machine looking at it. Nothing is uploaded.
 * ------------------------------------------------------------------------ */

// What the network was trained at. It is fully convolutional and will accept
// other sizes, but it was taught at this one and drifts if pushed far past it —
// and since its output is only ever a guide for the matcher, there is nothing
// to gain from asking for more.
const MODEL_SIZE = 512;
const MODEL_URL = "/models/migan_pipeline_v2.onnx";

// The runtime loads its own WebAssembly at run time, by name, and has to be
// told where to find it. Handing it a path under /public does not work: the
// loader half is a module, and Vite will not resolve a module out of /public —
// it refuses at dev time and silently ships a broken path in a build. Asking
// the bundler for the URLs instead means it emits both files as assets and
// hands back whatever they are really called, hashed or not.
//
// The jsep build is the one that can use WebGPU, and it runs plain WebAssembly
// too, so one pair covers both.
import wasmUrl from "./ortwasm/ort-wasm-simd-threaded.jsep.wasm?url";
import mjsUrl from "./ortwasm/ort-wasm-simd-threaded.jsep.mjs?url";

let runtime = null;          // the loaded onnxruntime module
let sessionPromise = null;   // in flight or resolved; only ever created once

// Loaded the first time somebody actually removes something, not on boot: it is
// 27MB of weights plus a WebAssembly runtime, and most visits to the board never
// touch the develop room at all.
async function getSession(onProgress) {
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    if (onProgress) onProgress("Fetching what it knows about photographs…");
    const ort = await import("onnxruntime-web");
    runtime = ort;
    ort.env.logLevel = "error";
    ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };

    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`no model (${res.status})`);

    // 27MB, once. On a good connection that is a blink and on a bad one it is
    // most of a minute, so it is counted out rather than left looking hung. The
    // browser caches it afterwards and the file never changes, so this is a
    // first-visit cost, not a per-removal one.
    const total = Number(res.headers.get("content-length")) || 0;
    let weights;
    if (total && res.body && res.body.getReader) {
      const reader = res.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        if (onProgress) onProgress(`Fetching what it knows about photographs… ${Math.round((got / total) * 100)}%`);
      }
      weights = new Uint8Array(got);
      let at = 0;
      for (const part of parts) { weights.set(part, at); at += part.length; }
    } else {
      weights = new Uint8Array(await res.arrayBuffer());
    }

    if (onProgress) onProgress("Waking it up…");
    // WebGPU where it exists and wasm everywhere else. Asking for both and
    // letting it pick means a machine without WebGPU still works, slower.
    const providers = ("gpu" in navigator) ? ["webgpu", "wasm"] : ["wasm"];
    return ort.InferenceSession.create(weights, { executionProviders: providers });
  })().catch((err) => {
    sessionPromise = null;               // a failed load may be worth retrying
    throw err;
  });

  return sessionPromise;
}

/** True once the weights are in memory, so callers can skip the wait message. */
export function guideReady() {
  return !!runtime && !!sessionPromise;
}

/**
 * Guess what is behind the masked part of a region of a picture.
 *
 * `image` is anything drawable and `mask` a canvas of the same size whose alpha
 * marks what to remove. `region` is the rectangle to work on. Returns a canvas
 * the size of that region, or null if the network could not be used at all —
 * in which case the caller carries on without it, which is the whole point of
 * it being a guide rather than the answer.
 */
export async function guessBehind({ image, mask, region, onProgress }) {
  let session;
  try {
    session = await getSession(onProgress);
  } catch {
    return null;                         // no model, no network, old browser
  }

  const S = MODEL_SIZE;
  const ort = runtime;

  // The region, squashed to the size the network expects.
  const flat = document.createElement("canvas");
  flat.width = S; flat.height = S;
  const fx = flat.getContext("2d", { willReadFrequently: true });
  fx.drawImage(image, region.x, region.y, region.w, region.h, 0, 0, S, S);
  const pixels = fx.getImageData(0, 0, S, S).data;

  const mflat = document.createElement("canvas");
  mflat.width = S; mflat.height = S;
  const mx = mflat.getContext("2d", { willReadFrequently: true });
  mx.drawImage(mask, region.x, region.y, region.w, region.h, 0, 0, S, S);
  const mpix = mx.getImageData(0, 0, S, S).data;

  // Planes, not interleaved bytes — and note the mask runs the other way round
  // to ours: 255 is photograph it may rely on, 0 is the part to invent.
  const plane = S * S;
  const img = new Uint8Array(3 * plane);
  const msk = new Uint8Array(plane);
  for (let i = 0; i < plane; i++) {
    img[i] = pixels[i * 4];
    img[plane + i] = pixels[i * 4 + 1];
    img[2 * plane + i] = pixels[i * 4 + 2];
    msk[i] = mpix[i * 4 + 3] > 24 ? 0 : 255;
  }

  if (onProgress) onProgress("Working out what was behind it…");

  let result;
  try {
    const out = await session.run({
      image: new ort.Tensor("uint8", img, [1, 3, S, S]),
      mask: new ort.Tensor("uint8", msk, [1, 1, S, S]),
    });
    result = out[session.outputNames[0]];
  } catch {
    return null;
  }
  if (!result || !result.data) return null;

  const got = result.data;
  const small = document.createElement("canvas");
  small.width = S; small.height = S;
  const sx = small.getContext("2d");
  const im = sx.createImageData(S, S);
  for (let i = 0; i < plane; i++) {
    im.data[i * 4] = got[i];
    im.data[i * 4 + 1] = got[plane + i];
    im.data[i * 4 + 2] = got[2 * plane + i];
    im.data[i * 4 + 3] = 255;
  }
  sx.putImageData(im, 0, 0);

  // Back up to the region's own size. This is an enlargement and it looks like
  // one; it is never shown. All it has to carry is where things are.
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(region.w));
  out.height = Math.max(1, Math.round(region.h));
  out.getContext("2d").drawImage(small, 0, 0, out.width, out.height);
  return out;
}
