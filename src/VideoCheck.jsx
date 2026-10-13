// Video check: drop in a video before posting it and get told what's working
// and what isn't.
//
// It all runs on this device and costs nothing — the video is never
// uploaded: it is played through a canvas and its sound decoded, and from
// that come the measurable things (length, shape, cuts, pace, the first
// seconds, light, sharpness, sound levels, whether it loops, and what's said).
// Those are set against this account's own reels where that means something
// (how long people actually watch).
import React, { useState, useRef, useMemo, useEffect } from "react";
import { Upload, AlertTriangle, Check, Info, Film } from "lucide-react";
import { kindOf, median, settled } from "./igInsights";
import { transcribe } from "./speech";

/* ------------------------------- measuring -------------------------------- */

const once = (el, event, ms = 8000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${event}`)); }, ms);
  const ok = () => { cleanup(); resolve(); };
  const bad = () => { cleanup(); reject(new Error("This browser can't play that file.")); };
  const cleanup = () => { clearTimeout(t); el.removeEventListener(event, ok); el.removeEventListener("error", bad); };
  el.addEventListener(event, ok);
  el.addEventListener("error", bad);
});

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}${s < 10 ? `.${Math.floor((s % 1) * 10)}` : ""}`;

// Per-frame numbers off a small copy of the frame: brightness, contrast,
// colourfulness (Hasler & Süsstrunk) and sharpness (variance of a Laplacian).
function frameStats(ctx, w, h) {
  const { data } = ctx.getImageData(0, 0, w, h);
  const luma = new Float32Array(w * h);
  let sum = 0;
  let rgSum = 0; let ybSum = 0; let rgSq = 0; let ybSq = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    luma[p] = y;
    sum += y;
    const rg = r - g; const yb = 0.5 * (r + g) - b;
    rgSum += rg; ybSum += yb; rgSq += rg * rg; ybSq += yb * yb;
  }
  const n = w * h;
  const mean = sum / n;
  let varSum = 0;
  for (let p = 0; p < n; p++) varSum += (luma[p] - mean) ** 2;
  const rgMean = rgSum / n; const ybMean = ybSum / n;
  const colour = Math.sqrt(Math.max(0, rgSq / n - rgMean ** 2) + Math.max(0, ybSq / n - ybMean ** 2)) + 0.3 * Math.sqrt(rgMean ** 2 + ybMean ** 2);
  let lap = 0; let lapSq = 0; let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const v = 4 * luma[p] - luma[p - 1] - luma[p + 1] - luma[p - w] - luma[p + w];
      lap += v; lapSq += v * v; count++;
    }
  }
  const sharp = count ? lapSq / count - (lap / count) ** 2 : 0;
  return { luma, mean, contrast: Math.sqrt(varSum / n), colour, sharp };
}

function lumaDiff(a, b) {
  if (!a || !b) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

const MAX_AUDIO_BYTES = 300 * 1024 * 1024;

/* A video to check: one just picked on this device, or one already in Drive,
   streamed through our server. Either way the checker needs a URL to play
   and, for the sound, the file's bytes. */
export function fileSource(file) {
  return { name: file.name, size: file.size, url: () => URL.createObjectURL(file), owned: true, bytes: () => file.arrayBuffer() };
}
export function driveSource(fileId, name) {
  const url = `/api/drive-stream?fileId=${encodeURIComponent(fileId)}`;
  return {
    name: name || "video",
    size: null,
    url: () => url,
    owned: false,
    // The stream answers in pieces of a few MB (one response can't be bigger),
    // so the whole file is read piece by piece.
    bytes: async () => {
      const parts = [];
      let start = 0;
      let total = null;
      while (total == null || start < total) {
        const res = await fetch(url, { headers: { Range: `bytes=${start}-${start + 4 * 1024 * 1024 - 1}` } });
        if (!res.ok) throw new Error(`Couldn't read the video from Drive (${res.status}).`);
        const range = /\/(\d+)$/.exec(res.headers.get("content-range") || "");
        total = range ? Number(range[1]) : Number(res.headers.get("content-length") || 0);
        if (total > MAX_AUDIO_BYTES) return null;
        const chunk = await res.arrayBuffer();
        if (!chunk.byteLength) break;
        parts.push(chunk);
        start += chunk.byteLength;
        if (!range) break; // the server sent it whole
      }
      const out = new Uint8Array(start);
      let at = 0;
      for (const part of parts) { out.set(new Uint8Array(part), at); at += part.byteLength; }
      return out.buffer;
    },
  };
}

async function measureAudio(bytes) {
  if (!bytes) return { status: "skipped" };
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return { status: "unsupported" };
  const ctx = new AC();
  try {
    // decodeAudioData takes ownership of the buffer; hand it a copy so the
    // same bytes can still be transcribed afterwards.
    const buf = await ctx.decodeAudioData(bytes.slice(0));
    const ch = buf.numberOfChannels;
    const rate = buf.sampleRate;
    const win = Math.floor(rate * 0.05);
    const chans = Array.from({ length: ch }, (_, i) => buf.getChannelData(i));
    const db = [];
    let clipped = 0; let peak = 0; let total = 0;
    for (let start = 0; start + win <= buf.length; start += win) {
      let power = 0;
      for (let i = start; i < start + win; i++) {
        let s = 0;
        for (const c of chans) s += c[i];
        s /= ch;
        power += s * s;
        const a = Math.abs(s);
        if (a > peak) peak = a;
        if (a >= 0.99) clipped++;
        total++;
      }
      db.push(10 * Math.log10(power / win + 1e-12));
    }
    const loudWindows = db.filter((v) => v > -50);
    if (!loudWindows.length) return { status: "silent", db, step: 0.05 };
    const loudness = 10 * Math.log10(loudWindows.reduce((a, v) => a + 10 ** (v / 10), 0) / loudWindows.length);
    const firstSound = db.findIndex((v) => v > -35) * 0.05;
    // Quiet stretches inside the video (not the very start or end).
    const gaps = [];
    let runStart = null;
    db.forEach((v, i) => {
      if (v < -45) { if (runStart == null) runStart = i; }
      else if (runStart != null) {
        if ((i - runStart) * 0.05 >= 1.5 && runStart > 0) gaps.push([runStart * 0.05, i * 0.05]);
        runStart = null;
      }
    });
    return { status: "ok", db, step: 0.05, loudness, peakDb: 20 * Math.log10(peak + 1e-12), clipPct: (clipped / total) * 100, firstSound, gaps };
  } catch {
    // Either no sound track at all, or a codec this browser won't decode.
    return { status: "none" };
  } finally {
    ctx.close().catch(() => {});
  }
}

// Walks the video once and hands every wanted moment to `take` with that
// moment's frame on screen. It plays the video through (muted, at 2-4x)
// rather than seeking: recordings made in a browser or some apps carry no
// seek index, and seeking in those silently lands on the first frame every
// time — the whole analysis would be of one frame. Playing is the one way
// every file reads correctly, and costs a few seconds.
async function walkFrames(video, duration, wants, take, onProgress) {
  // On the page but out of sight: some browsers stop decoding a video that
  // isn't in the document.
  Object.assign(video.style, { position: "fixed", left: "-10000px", top: "0", width: "2px", height: "2px", opacity: "0", pointerEvents: "none" });
  document.body.appendChild(video);
  try {
    video.currentTime = 0;
    await once(video, "seeked", 4000).catch(() => {});
    video.playbackRate = duration > 30 ? 4 : 2;
    let i = 0;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        while (i < wants.length) take(wants[i++]); // whatever is left gets the last frame
        video.pause();
        resolve();
      };
      const tick = () => {
        if (done) return;
        const at = video.currentTime;
        while (i < wants.length && wants[i].t <= at + 0.03) take(wants[i++]);
        onProgress(at / duration);
        if (i >= wants.length || video.ended) finish();
        else setTimeout(tick, 25);
      };
      video.addEventListener("ended", finish, { once: true });
      // A stalled file still finishes, with what it got.
      setTimeout(finish, (duration / video.playbackRate) * 1000 + 15000);
      video.play().then(tick, () => finish());
    });
  } finally {
    video.remove();
  }
}

export async function analyzeVideo(input, onProgress = () => {}) {
  const source = input instanceof Blob ? fileSource(input) : input;
  const url = source.url();
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await once(video, "loadedmetadata", 15000);
    let duration = video.duration;
    // Some recordings report an endless duration until seeked to the end.
    if (!Number.isFinite(duration)) {
      video.currentTime = 1e9;
      await once(video, "seeked", 8000).catch(() => {});
      duration = video.duration;
      if (!Number.isFinite(duration)) throw new Error("Couldn't tell how long this video is.");
    }
    if (video.readyState < 2) await once(video, "loadeddata", 15000).catch(() => {});
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error("No picture found in this file.");

    const sw = 128;
    const sh = Math.max(16, Math.round((sw * height) / width));
    const small = document.createElement("canvas");
    small.width = sw; small.height = sh;
    const sctx = small.getContext("2d", { willReadFrequently: true });
    const still = (maxW, quality) => {
      const c = document.createElement("canvas");
      const scale = Math.min(1, maxW / Math.max(width, height));
      c.width = Math.round(width * scale); c.height = Math.round(height * scale);
      c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", quality);
    };

    // What to look at: a sample every `step` seconds for the measurements,
    // and a strip of ten stills to show.
    const step = Math.max(0.2, duration / 220);
    const wants = [];
    for (let t = 0; t < duration; t += step) wants.push({ t, kind: "sample" });
    for (let k = 0; k < 10; k++) wants.push({ t: Math.min(duration - 0.1, (duration * k) / 9), kind: "strip" });
    wants.sort((a, b) => a.t - b.t);

    const samples = [];
    const strip = [];
    let prev = null;
    await walkFrames(video, duration, wants, (w) => {
      if (w.kind === "sample") {
        sctx.drawImage(video, 0, 0, sw, sh);
        const st = frameStats(sctx, sw, sh);
        samples.push({ t: w.t, mean: st.mean, contrast: st.contrast, colour: st.colour, sharp: st.sharp, diff: prev ? lumaDiff(st.luma, prev) : 0, luma: st.luma });
        prev = st.luma;
      } else strip.push({ t: w.t, src: still(200, 0.6) });
    }, (f) => onProgress(0.03 + 0.8 * Math.min(1, f)));

    onProgress(0.86);
    let bytes = null;
    if (source.size == null || source.size <= MAX_AUDIO_BYTES) bytes = await source.bytes().catch(() => null);
    const audio = await measureAudio(bytes);
    onProgress(1);
    const result = summarize({ source, duration, width, height, samples, strip, audio, step });
    // Kept for transcribing without reading the file a second time.
    Object.defineProperty(result, "bytes", { value: bytes, enumerable: false });
    return result;
  } finally {
    video.removeAttribute("src");
    video.load();
    if (source.owned) URL.revokeObjectURL(url);
  }
}

function summarize({ source, duration, width, height, samples, strip, audio, step }) {
  const diffs = samples.slice(1).map((s) => s.diff);
  const base = median(diffs) || 0;
  const mad = median(diffs.map((d) => Math.abs(d - base))) || 1;
  const threshold = Math.max(18, base + 6 * mad);
  const cuts = [];
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i].diff;
    const neighbour = Math.max(samples[i - 1]?.diff || 0, samples[i + 1]?.diff || 0);
    if (d > threshold && d >= neighbour) cuts.push(samples[i].t);
  }
  const motionOf = (list) => median(list.filter((s, i) => i > 0 && s.diff < threshold).map((s) => s.diff)) || 0;
  const opening = samples.filter((s) => s.t < 1.6);
  const rest = samples.filter((s) => s.t >= 1.6);
  // Stretches where almost nothing changes on screen.
  const still = [];
  let runStart = null;
  samples.forEach((s, i) => {
    if (i > 0 && s.diff < 1.2) { if (runStart == null) runStart = s.t; }
    else if (runStart != null) { if (s.t - runStart >= 3) still.push([runStart, s.t]); runStart = null; }
  });
  if (runStart != null && duration - runStart >= 3) still.push([runStart, duration]);
  const shots = [0, ...cuts, duration].slice(1).map((t, i, arr) => t - (i ? arr[i - 1] : 0));
  const sharpMedian = median(samples.map((s) => s.sharp)) || 0;
  const blurry = samples.filter((s) => s.sharp < sharpMedian * 0.35).length / (samples.length || 1);

  return {
    name: source.name,
    sizeMb: source.size == null ? null : source.size / 1048576,
    duration, width, height,
    aspect: width / height,
    step,
    cuts,
    firstCut: cuts.find((t) => t > 0.2) ?? null,
    cutsPer10s: (cuts.length / duration) * 10,
    longestShot: shots.length ? Math.max(...shots) : duration,
    motionOpening: motionOf(opening),
    motionRest: motionOf(rest.length ? rest : samples),
    still,
    brightness: median(samples.map((s) => s.mean)),
    firstBrightness: samples[0]?.mean ?? null,
    contrast: median(samples.map((s) => s.contrast)),
    colour: median(samples.map((s) => s.colour)),
    blurryShare: blurry,
    loops: samples.length > 2 ? lumaDiff(samples[0].luma, samples[samples.length - 1].luma) < 10 : false,
    timeline: samples.map((s) => ({ t: s.t, diff: s.diff })),
    strip,
    audio,
  };
}

/* ------------------------------- judging ---------------------------------- */

const ASPECTS = {
  reel: { ideal: 9 / 16, name: "9:16 (vertical)" },
  feed: { ideal: 4 / 5, name: "4:5" },
  story: { ideal: 9 / 16, name: "9:16 (vertical)" },
};

// What this account's own reels say about attention, for the length advice.
export function accountContext(media) {
  const reels = media.filter((m) => kindOf(m) === "REELS" && settled(m))
    .sort((a, b) => b.posted_at.localeCompare(a.posted_at)).slice(0, 30);
  if (reels.length < 5) return null;
  const top = [...reels].sort((a, b) => (b.reach || 0) - (a.reach || 0)).slice(0, Math.ceil(reels.length / 4));
  return {
    reels: reels.length,
    watch: median(reels.map((m) => (m.avg_watch_time_ms ? m.avg_watch_time_ms / 1000 : null))),
    topWatch: median(top.map((m) => (m.avg_watch_time_ms ? m.avg_watch_time_ms / 1000 : null))),
    reach: median(reels.map((m) => m.reach)),
    topCaptions: top.slice(0, 3).map((m) => (m.caption || "").slice(0, 300)),
  };
}

export function judge(a, format, context, caption) {
  const out = [];
  const add = (level, area, title, detail, at) => out.push({ level, area, title, detail, at });
  const target = ASPECTS[format];

  // Shape and quality
  const off = Math.abs(a.aspect - target.ideal) / target.ideal;
  if (off < 0.04) add("good", "Format", `Right shape: ${a.width}×${a.height}`, `Fills the screen as a ${format === "feed" ? "feed post" : format}.`);
  else if (a.aspect > 1) add("bad", "Format", `Horizontal video (${a.width}×${a.height})`, `It will show with big empty bars. Crop or re-film to ${target.name}.`);
  else add("warn", "Format", `Not quite ${target.name} (${a.width}×${a.height})`, "Instagram will crop or letterbox it; check nothing important sits near the edges.");
  const shortSide = Math.min(a.width, a.height);
  if (shortSide < 720) add("bad", "Format", `Low resolution (${shortSide}p)`, "Export at 1080 wide — Instagram compresses hard and low-resolution video turns to mush.");
  else if (shortSide < 1080) add("warn", "Format", `${shortSide}p`, "1080 wide is the sweet spot; this will look slightly soft.");

  // Length vs real attention
  if (format !== "feed" && a.duration > 90) add("bad", "Length", `${a.duration.toFixed(0)} s is longer than a reel can be`, "Reels top out at 90 seconds in most places; cut it down.");
  if (context?.watch) {
    const w = context.watch;
    if (a.duration <= w * 1.3) add("good", "Length", `${a.duration.toFixed(1)} s — close to how long people actually watch`, `Your reels are watched for about ${w.toFixed(1)} s on average, so most viewers will see all of it, and short reels loop — loops count as more views.`);
    else if (a.duration <= w * 3) add("warn", "Length", `${a.duration.toFixed(1)} s, but people watch your reels for about ${w.toFixed(1)} s`, `Make sure the point lands inside the first ${Math.round(w)} seconds. Your best-reaching reels hold people for about ${(context.topWatch || w).toFixed(1)} s.`);
    else add("bad", "Length", `${a.duration.toFixed(0)} s — several times longer than people watch`, `Your reels are watched for about ${w.toFixed(1)} s. Most viewers will leave before the middle. Cut to the strongest ${Math.round(w * 2)}–${Math.round(w * 3)} seconds, or put the payoff first.`);
  } else if (a.duration > 30) add("warn", "Length", `${a.duration.toFixed(0)} s`, "Long for a reel. Make sure the first 3 seconds give a reason to stay.");

  // The opening
  if (a.firstBrightness != null && a.firstBrightness < 28) add("bad", "Opening", "Opens on a near-black frame", "The first frame is what people decide on, and it's also the default cover. Start on the subject.", 0);
  if (a.firstCut != null && a.firstCut <= 1.6) add("good", "Opening", `Something changes within ${a.firstCut.toFixed(1)} s`, "An early cut or change gives the eye a reason to stay.", a.firstCut);
  else if (a.motionOpening < 2 && (a.firstCut == null || a.firstCut > 3)) add("bad", "Opening", "The first seconds barely move", `Nothing cuts or moves much until ${a.firstCut ? fmtTime(a.firstCut) : "much later"}. Open on movement, a face, or text that sets up a question.`, 0);
  else if (a.firstCut == null || a.firstCut > 3) add("warn", "Opening", `First cut at ${a.firstCut ? fmtTime(a.firstCut) : "—"}`, "The opening is one long shot. Fine if something happens in it — otherwise cut in sooner.", 0);

  // Pace
  if (a.cuts.length === 0 && a.duration > 8) add("warn", "Pace", "One continuous shot", "No cuts at all. That works for a strong single moment; otherwise add a cut every few seconds.");
  else if (a.cutsPer10s >= 1.5 && a.cutsPer10s <= 6) add("good", "Pace", `${a.cuts.length} cuts — about one every ${(10 / a.cutsPer10s).toFixed(1)} s`, "A pace that keeps things moving without becoming hard to follow.");
  else if (a.cutsPer10s > 8) add("warn", "Pace", `Very fast: ${a.cutsPer10s.toFixed(1)} cuts per 10 s`, "So fast that text or faces may not register. Give key moments a beat longer.");
  if (a.longestShot > 6 && a.duration > 10) add("warn", "Pace", `A ${a.longestShot.toFixed(1)} s shot with no cut`, "Long shots are where people drop off. Trim it or cut away mid-way.");
  for (const [from, to] of a.still.slice(0, 3)) add("warn", "Pace", `Nothing moves ${fmtTime(from)}–${fmtTime(to)}`, "Almost no change on screen for over 3 seconds. Unless there's text to read, cut it shorter.", from);

  // Look
  if (a.brightness < 55) add("warn", "Look", "Dark overall", "Phones show dark footage murky after compression. Lift exposure or shadows a little.");
  else if (a.brightness > 205) add("warn", "Look", "Very bright", "Highlights may be blown out. Bring exposure down slightly.");
  else add("good", "Look", "Exposure looks right", "Neither murky nor blown out.");
  if (a.contrast < 32) add("warn", "Look", "Flat, low contrast", "Add a little contrast so it doesn't look washed out in the feed.");
  if (a.blurryShare > 0.25) add("warn", "Look", `About ${Math.round(a.blurryShare * 100)}% of it is noticeably soft`, "Blurry stretches — focus missed or heavy motion blur. Check those parts.");

  // Sound
  const au = a.audio;
  if (au.status === "none" || au.status === "silent") add("bad", "Sound", au.status === "silent" ? "The sound track is silent" : "No sound found", "Most reels are watched with sound on. Add music or voice — or, if it's meant to be silent, make sure on-screen text carries it.");
  else if (au.status === "ok") {
    if (au.firstSound > 0.6) add("warn", "Sound", `${au.firstSound.toFixed(1)} s of silence at the start`, "Start the sound right away; silence reads as a slow start.", 0);
    if (au.loudness < -26) add("warn", "Sound", `Quiet (${au.loudness.toFixed(0)} dB)`, "Next to other reels this will sound faint. Raise the level so voice peaks near −6 dB.");
    else if (au.loudness > -9) add("warn", "Sound", `Very loud (${au.loudness.toFixed(0)} dB)`, "Close to the ceiling; it may sound harsh after Instagram's processing.");
    else add("good", "Sound", `Healthy level (${au.loudness.toFixed(0)} dB)`, "Loud enough to hold its own in the feed.");
    if (au.clipPct > 0.05) add("bad", "Sound", "The sound distorts (clipping)", "Parts hit the ceiling and crackle. Lower the level before exporting.");
    for (const [from, to] of au.gaps.slice(0, 2)) add("warn", "Sound", `Sound drops out ${fmtTime(from)}–${fmtTime(to)}`, "A silent gap mid-video. Fill it or cut it.", from);
  } else if (au.status === "skipped") add("info", "Sound", "Sound not checked", "The file is too large to read the sound in the browser.");

  if (a.loops && format !== "feed") add("good", "Ending", "Loops back to the start cleanly", "The last frame matches the first, so a replay feels seamless — replays count as views.");

  // Caption
  if (caption != null && caption.trim()) {
    const firstLine = caption.split("\n")[0];
    const tags = (caption.match(/#[\p{L}\p{N}_]+/gu) || []).length;
    if (firstLine.length > 125) add("warn", "Caption", "The first line runs past the cut-off", `Instagram shows about 125 characters before "more"; this first line is ${firstLine.length}.`);
    if (tags > 10) add("warn", "Caption", `${tags} hashtags`, "3–5 that really describe it read better and do as well.");
    if (!/\?/.test(caption) && !/\b(save|share|comment|tag|follow|kerro|jaa|tallenna|kommentoi)\b/i.test(caption)) add("info", "Caption", "No question or call to action", "Asking people something, or to save or share, gives them a reason to act.");
  }
  return out;
}

// What the words say: when speech starts, how fast it goes, and the reminder
// that most people will read it rather than hear it.
export function speechFindings(sp) {
  const out = [];
  if (!sp) return out;
  const add = (level, title, detail, at) => out.push({ level, area: "Speech", title, detail, at });
  if (sp.status === "nospeech") { add("info", "No speech heard", "If there's meant to be talking, it's too quiet or buried under music."); return out; }
  if (sp.status !== "ok") return out;
  if (sp.firstWordAt > 1.5) add("warn", `The first word comes at ${fmtTime(sp.firstWordAt)}`, "Open with the line that makes people stay — don't warm up first.", sp.firstWordAt);
  else add("good", "Talking starts right away", `The first words: “${sp.opening}”`, sp.firstWordAt);
  if (sp.wordsPerMinute > 200) add("warn", `Fast: about ${sp.wordsPerMinute} words a minute`, "Hard to follow, and hard to read as subtitles. Cut words rather than speed up.");
  else if (sp.wordsPerMinute < 100 && sp.words > 15) add("warn", `Slow: about ${sp.wordsPerMinute} words a minute`, "Tighten the pauses — a reel can carry a brisker pace than a conversation.");
  else add("good", `Comfortable pace (${sp.wordsPerMinute} words a minute)`, "Easy to follow, and readable as subtitles.");
  add("info", "Burn in subtitles", "Much of the feed watches with the sound off; subtitles carry the talking to them. The transcript is a starting point.");
  return out;
}

const SPEECH_LANGS = [["auto", "Any language"], ["fi", "Finnish"], ["en", "English"]];

// Transcribe button, progress and result. getBytes returns the video file's
// bytes (or null if they can't be read).
export function SpeechPanel({ speech, getBytes, onDone, onSeek }) {
  const [lang, setLang] = useState("auto");
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);
  const run = async () => {
    setError("");
    setBusy({ stage: "audio" });
    try {
      const bytes = await getBytes();
      if (!bytes) throw new Error("The file is too large to read the sound in the browser.");
      onDone(await transcribe(bytes, { language: lang, onProgress: setBusy }));
    } catch (err) {
      setError(err.message || "Couldn't transcribe this one.");
    }
    setBusy(null);
  };
  const pctDone = busy && busy.stage === "download" && busy.total ? Math.round((busy.loaded / busy.total) * 100) : null;
  const status = !busy ? null
    : busy.stage === "download" ? `Fetching the speech model, once on this device… ${pctDone}%`
    : busy.stage === "listening" ? "Listening… about as long as the video, often less."
    : "Reading the sound…";
  return (
    <div className="vc-speech">
      {speech?.status === "ok" ? (
        <>
          <div className="vc-speech-facts">
            <span>First word at <b>{fmtTime(speech.firstWordAt)}</b></span>
            <span><b>{speech.wordsPerMinute}</b> words a minute</span>
            <span><b>{speech.words}</b> words</span>
          </div>
          <div className="vc-transcript">
            {(showAll ? speech.chunks : speech.chunks.slice(0, 6)).map((c, i) => (
              <p key={i}>
                <button className="vc-at" onClick={() => onSeek?.(c.from)} disabled={!onSeek}>{fmtTime(c.from)}</button> {c.text}
              </p>
            ))}
            {speech.chunks.length > 6 ? <button className="btn btn-ghost" onClick={() => setShowAll(!showAll)}>{showAll ? "Show less" : `Show all ${speech.chunks.length} lines`}</button> : null}
          </div>
        </>
      ) : speech?.status === "nospeech" ? <p className="ig-dim" style={{ margin: "0 0 8px" }}>No speech heard in this one.</p>
        : speech?.status === "noaudio" ? <p className="ig-dim" style={{ margin: "0 0 8px" }}>This video has no sound track to transcribe.</p> : null}
      {busy ? (
        <div className="vc-progress"><span style={{ width: pctDone != null ? `${pctDone}%` : "100%" }} /><em>{status}</em></div>
      ) : (
        <div className="vc-speech-run">
          <select value={lang} onChange={(e) => setLang(e.target.value)}>
            {SPEECH_LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button className="btn" onClick={run}>{speech ? "Transcribe again" : "Transcribe the speech"}</button>
          {!speech ? <span className="ig-dim">Runs on this device. The first time fetches an ~80 MB speech model.</span> : null}
        </div>
      )}
      {error ? <div className="ig-note ig-note-bad"><AlertTriangle size={14} /> {error}</div> : null}
    </div>
  );
}

// Content Review: everything worth keeping from a check, small enough to store
// on the piece itself (no pictures).
export async function checkForUpload(source, { media, caption, format = "reel", onProgress } = {}) {
  const a = await analyzeVideo(source, onProgress);
  const findings = judge(a, format, accountContext(media || []), caption);
  return {
    stored: {
      at: new Date().toISOString().slice(0, 10),
      duration: Number(a.duration.toFixed(2)),
      width: a.width,
      height: a.height,
      cuts: a.cuts.length,
      loudness: a.audio.status === "ok" ? Math.round(a.audio.loudness) : null,
      // Kept for "what the videos people watched longest had in common".
      firstCut: a.firstCut == null ? null : Number(a.firstCut.toFixed(1)),
      longestShot: Number(a.longestShot.toFixed(1)),
      cutsPer10s: Number(a.cutsPer10s.toFixed(2)),
      stillSeconds: Number(a.still.reduce((sum, [from, to]) => sum + (to - from), 0).toFixed(1)),
      findings: findings.map(({ level, area, title, detail, at }) => ({ level, area, title, detail, at: at ?? null })),
    },
    bytes: a.bytes,
  };
}

/* --------------------------------- the view -------------------------------- */

const LEVEL = {
  good: { icon: Check, color: "var(--good)", label: "Working" },
  warn: { icon: AlertTriangle, color: "var(--gold)", label: "Check" },
  bad: { icon: AlertTriangle, color: "var(--alert)", label: "Fix" },
  info: { icon: Info, color: "var(--muted)", label: "Note" },
};

function Timeline({ a, onSeek }) {
  const W = 600; const H = 70;
  const maxDiff = Math.max(20, ...a.timeline.map((p) => p.diff));
  const x = (t) => (t / a.duration) * W;
  const motion = a.timeline.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${(H - 4 - (Math.min(p.diff, maxDiff) / maxDiff) * (H - 12)).toFixed(1)}`).join(" ");
  let sound = null;
  if (a.audio.status === "ok") {
    const every = Math.max(1, Math.floor(a.audio.db.length / 300));
    const pts = [];
    for (let i = 0; i < a.audio.db.length; i += every) {
      const v = Math.max(-60, a.audio.db[i]);
      pts.push(`${pts.length ? "L" : "M"}${x(i * a.audio.step).toFixed(1)},${(H - 4 - ((v + 60) / 60) * (H - 12)).toFixed(1)}`);
    }
    sound = pts.join(" ");
  }
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" className="vc-timeline"
        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); onSeek(((e.clientX - r.left) / r.width) * a.duration); }}>
        {a.still.map(([f, t]) => <rect key={f} x={x(f)} y="0" width={x(t) - x(f)} height={H} fill="rgba(217,86,75,0.14)" />)}
        {sound ? <path d={sound} fill="none" stroke="#2E9C88" strokeWidth="1.2" opacity="0.8" vectorEffect="non-scaling-stroke" /> : null}
        <path d={motion} fill="none" stroke="#B08B33" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        {a.cuts.map((t) => <line key={t} x1={x(t)} x2={x(t)} y1="0" y2={H} stroke="#EDEBE3" strokeWidth="1" opacity="0.35" vectorEffect="non-scaling-stroke" />)}
      </svg>
      <div className="vc-legend">
        <span><i style={{ background: "#B08B33" }} /> Movement</span>
        {sound ? <span><i style={{ background: "#2E9C88" }} /> Loudness</span> : null}
        <span><i style={{ background: "rgba(237,235,227,0.5)", width: 2 }} /> Cuts</span>
        {a.still.length ? <span><i style={{ background: "rgba(217,86,75,0.4)" }} /> Nothing moving</span> : null}
        <span className="ig-dim">Tap to jump there</span>
      </div>
    </div>
  );
}

export default function VideoCheck({ media }) {
  const [file, setFile] = useState(null);
  const [format, setFormat] = useState("reel");
  const [caption, setCaption] = useState("");
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [speech, setSpeech] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [dragging, setDragging] = useState(false);
  const previewRef = useRef(null);
  const inputRef = useRef(null);
  const context = useMemo(() => accountContext(media || []), [media]);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const run = async (f) => {
    if (!f) return;
    if (!f.type.startsWith("video/")) { setError("That isn't a video file."); return; }
    setFile(f);
    setError("");
    setResult(null);
    setSpeech(null);
    setProgress(0);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(f));
    try {
      setResult(await analyzeVideo(f, setProgress));
    } catch (err) {
      setError(err.message || "Couldn't read that video.");
    }
    setProgress(null);
  };

  const findings = useMemo(() => (result ? [...judge(result, format, context, caption), ...speechFindings(speech)] : []), [result, format, context, caption, speech]);
  const counts = findings.reduce((acc, f) => ({ ...acc, [f.level]: (acc[f.level] || 0) + 1 }), {});
  const seekTo = (t) => { if (previewRef.current) { previewRef.current.currentTime = t; previewRef.current.play().catch(() => {}); } };

  return (
    <div className="vc-root">
      <section className="ig-card">
        <h3>Check a video before you post it</h3>
        <p className="ig-dim ig-review-sub">
          The video stays on this device — it's measured right here in the browser, and it's free.
        </p>
        <div
          className={`vc-drop${dragging ? " on" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); run(e.dataTransfer.files?.[0]); }}
        >
          <Upload size={22} />
          <div>{file ? <><strong>{file.name}</strong> — drop another to check it instead</> : <><strong>Choose a video</strong> or drop it here</>}</div>
          <input ref={inputRef} type="file" accept="video/*" style={{ display: "none" }} onChange={(e) => { run(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
        <div className="vc-options">
          <div className="ig-seg">
            {[["reel", "Reel"], ["feed", "Feed video"], ["story", "Story"]].map(([v, l]) => (
              <button key={v} className={format === v ? "on" : ""} onClick={() => setFormat(v)}>{l}</button>
            ))}
          </div>
          <textarea className="vc-caption" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Caption you're planning (optional) — it gets checked too" rows={2} />
        </div>
        {progress != null ? (
          <div className="vc-progress"><span style={{ width: `${Math.round(progress * 100)}%` }} /><em>Watching the video… {Math.round(progress * 100)}%</em></div>
        ) : null}
        {error ? <div className="ig-note ig-note-bad"><AlertTriangle size={14} /> {error}</div> : null}
      </section>

      {result ? (
        <>
          <section className="ig-card">
            <div className="vc-top">
              {previewUrl ? <video ref={previewRef} className="vc-preview" src={previewUrl} controls playsInline muted /> : null}
              <div className="vc-facts">
                <div className="vc-tally">
                  {["bad", "warn", "good"].map((l) => (counts[l] ? <span key={l} style={{ color: LEVEL[l].color }}>{counts[l]} {LEVEL[l].label.toLowerCase()}</span> : null))}
                </div>
                <dl>
                  <dt>Length</dt><dd>{result.duration.toFixed(1)} s</dd>
                  <dt>Size</dt><dd>{result.width}×{result.height}</dd>
                  <dt>Cuts</dt><dd>{result.cuts.length}{result.firstCut != null ? `, first at ${fmtTime(result.firstCut)}` : ""}</dd>
                  <dt>Longest shot</dt><dd>{result.longestShot.toFixed(1)} s</dd>
                  <dt>Sound</dt><dd>{result.audio.status === "ok" ? `${result.audio.loudness.toFixed(0)} dB` : result.audio.status === "skipped" ? "not checked" : "none"}</dd>
                  {context?.watch ? <><dt>Your reels are watched</dt><dd>~{context.watch.toFixed(1)} s</dd></> : null}
                </dl>
              </div>
            </div>
            <Timeline a={result} onSeek={seekTo} />
            <div className="vc-strip">
              {result.strip.map((s) => <button key={s.t} onClick={() => seekTo(s.t)}><img src={s.src} alt="" /><span>{fmtTime(s.t)}</span></button>)}
            </div>
          </section>

          <section className="ig-card">
            <h3>What the measurements say</h3>
            <ul className="vc-findings">
              {[...findings].sort((x, y) => ["bad", "warn", "info", "good"].indexOf(x.level) - ["bad", "warn", "info", "good"].indexOf(y.level)).map((f) => {
                const L = LEVEL[f.level];
                const Icon = L.icon;
                return (
                  <li key={f.area + f.title}>
                    <Icon size={15} color={L.color} />
                    <div>
                      <div className="vc-finding-title">
                        <span className="vc-area">{f.area}</span>
                        {f.title}
                        {f.at != null ? <button className="vc-at" onClick={() => seekTo(f.at)}>{fmtTime(f.at)}</button> : null}
                      </div>
                      <div className="ig-dim">{f.detail}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
            {!context ? <p className="ig-dim" style={{ marginTop: 10 }}>Length advice gets specific once there are five or more of your reels with numbers.</p> : null}
          </section>

          <section className="ig-card">
            <h3>What's said</h3>
            <SpeechPanel speech={speech} onDone={setSpeech} onSeek={seekTo} getBytes={async () => result.bytes || (file ? file.arrayBuffer() : null)} />
          </section>

        </>
      ) : !progress && !error ? (
        <div className="ig-connect">
          <Film size={26} strokeWidth={1.5} />
          <p>Pick a video to see how it measures up — the opening, the pace, the sound, the length against how long your audience actually watches.</p>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------- on a Content Review card ---------------------------- */

const LEVEL_ORDER = ["bad", "warn", "info", "good"];

// The check a video got when it was uploaded, on its review card: a one-line
// tally that opens into the findings and the transcript. Older uploads, or a
// new version, can be checked from Drive with one tap.
export function UploadCheck({ item, fileId, getMedia, onSave }) {
  const check = item.videoCheck || null;
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const bytesRef = useRef(null);

  const run = async () => {
    setBusy(0);
    setError("");
    try {
      const media = await getMedia();
      const { stored, bytes } = await checkForUpload(driveSource(fileId, item.title), { media, caption: item.caption, onProgress: setBusy });
      bytesRef.current = bytes;
      onSave({ ...stored, speech: check?.speech || null });
      setOpen(true);
    } catch (err) {
      setError(err.message || "Couldn't check this video.");
    }
    setBusy(null);
  };
  // Kept small: the transcript lives on the board everyone downloads.
  const saveSpeech = (sp) => onSave({ ...check, speech: sp.status === "ok" ? { ...sp, chunks: sp.chunks.slice(0, 40), text: sp.text.slice(0, 2000) } : sp });

  const findings = check ? [...check.findings, ...speechFindings(check.speech)].sort((x, y) => LEVEL_ORDER.indexOf(x.level) - LEVEL_ORDER.indexOf(y.level)) : [];
  const counts = findings.reduce((acc, f) => ({ ...acc, [f.level]: (acc[f.level] || 0) + 1 }), {});

  if (busy != null) {
    return <div className="vc-progress" style={{ marginBottom: 12 }}><span style={{ width: `${Math.round(busy * 100)}%` }} /><em>Checking the video… {Math.round(busy * 100)}%</em></div>;
  }
  if (!check) {
    return (
      <div className="vcu">
        <button className="btn" onClick={run}><Film size={13} /> Check this video</button>
        <span className="ig-dim"> Opening, pace, sound and length against how long your reels are watched.</span>
        {error ? <div className="ig-note ig-note-bad" style={{ marginTop: 8 }}><AlertTriangle size={14} /> {error}</div> : null}
      </div>
    );
  }
  return (
    <div className="vcu">
      <button className="vcu-head" onClick={() => setOpen(!open)}>
        <Film size={14} />
        <span>Video check</span>
        <span className="vc-tally" style={{ margin: 0 }}>
          {["bad", "warn", "good"].map((l) => (counts[l] ? <span key={l} style={{ color: LEVEL[l].color }}>{counts[l]} {LEVEL[l].label.toLowerCase()}</span> : null))}
        </span>
        <span className="ig-dim" style={{ marginLeft: "auto" }}>{check.duration.toFixed(1)} s · {check.width}×{check.height}{open ? " · hide" : " · show"}</span>
      </button>
      {open ? (
        <>
          <ul className="vc-findings">
            {findings.map((f) => {
              const L = LEVEL[f.level];
              const Icon = L.icon;
              return (
                <li key={f.area + f.title}>
                  <Icon size={15} color={L.color} />
                  <div>
                    <div className="vc-finding-title"><span className="vc-area">{f.area}</span>{f.title}{f.at != null ? <span className="vc-at">{fmtTime(f.at)}</span> : null}</div>
                    <div className="ig-dim">{f.detail}</div>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="vcu-speech">
            <div className="vc-finding-title"><span className="vc-area">Speech</span>What's said</div>
            <SpeechPanel speech={check.speech} onDone={saveSpeech} getBytes={async () => bytesRef.current || driveSource(fileId).bytes()} />
          </div>
          <button className="btn btn-ghost" onClick={run} style={{ marginTop: 6 }}>Check again</button>
        </>
      ) : null}
      {error ? <div className="ig-note ig-note-bad" style={{ marginTop: 8 }}><AlertTriangle size={14} /> {error}</div> : null}
    </div>
  );
}
