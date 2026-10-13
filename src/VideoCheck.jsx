// Video check: drop in a video before posting it and get told what's working
// and what isn't.
//
// Two layers. The first runs entirely on this device — the video is never
// uploaded: it is played through a canvas and its sound decoded, and from
// that come the measurable things (length, shape, cuts, pace, the first
// seconds, light, sharpness, sound levels, whether it loops). Those are set
// against this account's own reels where that means something (how long
// people actually watch). The second layer is optional: eight still frames and
// the measurements go to Claude (api/video-review.js) for the things a
// measurement can't judge — is the opening interesting, is the on-screen text
// readable, does the caption pull its weight.
import React, { useState, useRef, useMemo, useEffect } from "react";
import { Upload, AlertTriangle, Check, Sparkles, ArrowUpRight, ArrowDownRight, Info, Film } from "lucide-react";
import { kindOf, median, settled } from "./igInsights";

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

async function measureAudio(file) {
  if (file.size > 300 * 1024 * 1024) return { status: "skipped" };
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return { status: "unsupported" };
  const ctx = new AC();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
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

export async function analyzeVideo(file, onProgress) {
  const url = URL.createObjectURL(file);
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

    // What to look at: a sample every `step` seconds for the measurements, a
    // strip of ten stills to show, and eight sharper stills for the AI review,
    // weighted toward the opening because that's where a reel is won or lost.
    const step = Math.max(0.2, duration / 220);
    const wants = [];
    for (let t = 0; t < duration; t += step) wants.push({ t, kind: "sample" });
    for (let k = 0; k < 10; k++) wants.push({ t: Math.min(duration - 0.1, (duration * k) / 9), kind: "strip" });
    const keyTimes = [0, 0.7, 1.6, 3].filter((t) => t < duration);
    while (keyTimes.length < 7) keyTimes.push(3 + ((duration - 3) * (keyTimes.length - 3)) / 4);
    keyTimes.push(Math.max(0, duration - 0.3));
    for (const t of [...new Set(keyTimes.map((x) => Math.round(x * 10) / 10))].filter((x) => x >= 0 && x < duration).slice(0, 8)) wants.push({ t, kind: "key" });
    wants.sort((a, b) => a.t - b.t);

    const samples = [];
    const strip = [];
    const keyframes = [];
    let prev = null;
    await walkFrames(video, duration, wants, (w) => {
      if (w.kind === "sample") {
        sctx.drawImage(video, 0, 0, sw, sh);
        const st = frameStats(sctx, sw, sh);
        samples.push({ t: w.t, mean: st.mean, contrast: st.contrast, colour: st.colour, sharp: st.sharp, diff: prev ? lumaDiff(st.luma, prev) : 0, luma: st.luma });
        prev = st.luma;
      } else if (w.kind === "strip") strip.push({ t: w.t, src: still(200, 0.6) });
      else keyframes.push({ t: w.t, src: still(640, 0.72) });
    }, (f) => onProgress(0.03 + 0.8 * Math.min(1, f)));

    onProgress(0.86);
    const audio = await measureAudio(file);
    onProgress(1);
    return summarize({ file, duration, width, height, samples, strip, keyframes, audio, step });
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

function summarize({ file, duration, width, height, samples, strip, keyframes, audio, step }) {
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
    name: file.name,
    sizeMb: file.size / 1048576,
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
    keyframes,
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
function accountContext(media) {
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
  const [ai, setAi] = useState(null);
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
    setAi(null);
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

  const findings = useMemo(() => (result ? judge(result, format, context, caption) : []), [result, format, context, caption]);
  const counts = findings.reduce((acc, f) => ({ ...acc, [f.level]: (acc[f.level] || 0) + 1 }), {});
  const seekTo = (t) => { if (previewRef.current) { previewRef.current.currentTime = t; previewRef.current.play().catch(() => {}); } };

  const askAi = async () => {
    setAi("loading");
    try {
      const a = result;
      const res = await fetch("/api/video-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "video",
          format,
          caption,
          frames: a.keyframes.map((k) => ({ t: Number(k.t.toFixed(1)), data: k.src.split(",")[1] })),
          stats: {
            duration: Number(a.duration.toFixed(1)),
            resolution: `${a.width}x${a.height}`,
            cuts: a.cuts.length,
            firstCut: a.firstCut == null ? null : Number(a.firstCut.toFixed(1)),
            longestShot: Number(a.longestShot.toFixed(1)),
            stillStretches: a.still.map(([f, t]) => `${fmtTime(f)}-${fmtTime(t)}`),
            brightness: Math.round(a.brightness),
            sound: a.audio.status === "ok" ? { loudnessDb: Math.round(a.audio.loudness), silenceAtStartSec: Number(a.audio.firstSound.toFixed(1)), dropouts: a.audio.gaps.length, clipping: a.audio.clipPct > 0.05 } : a.audio.status,
            loops: a.loops,
          },
          checks: findings.map((f) => `${LEVEL[f.level].label}: ${f.title}`),
          account: context ? { reelsCompared: context.reels, avgWatchSec: context.watch, bestReelsWatchSec: context.topWatch, typicalReach: context.reach, bestCaptions: context.topCaptions } : null,
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `The AI review failed (${res.status}).`);
      setAi(out);
    } catch (err) {
      setAi({ error: err.message });
    }
  };

  return (
    <div className="vc-root">
      <section className="ig-card">
        <h3>Check a video before you post it</h3>
        <p className="ig-dim ig-review-sub">
          The video stays on this device — it's measured right here in the browser. Only if you ask for the AI review
          do eight still frames and the measurements leave it.
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
            <div className="ig-card-head">
              <h3>AI review</h3>
              {ai !== "loading" ? <button className="btn btn-gold" onClick={askAi}><Sparkles size={14} /> {ai && !ai.error ? "Review again" : "Review it"}</button> : null}
            </div>
            {!ai ? <p className="ig-dim" style={{ margin: 0 }}>Looks at eight frames (most of them from the opening seconds) together with the measurements and your caption, and judges what a measurement can't: whether the opening is interesting, whether text is readable and clear of Instagram's buttons, and what to change first.</p> : null}
            {ai === "loading" ? <div className="ig-empty-chart">Watching the frames… this takes up to a minute.</div> : null}
            {ai?.error ? <div className="ig-note ig-note-bad"><AlertTriangle size={14} /> {ai.error}</div> : null}
            {ai && ai !== "loading" && !ai.error ? <AiFeedback result={ai} /> : null}
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

// The shape api/video-review.js returns, for a posted post or a video check.
export function AiFeedback({ result }) {
  return (
    <div className="ig-ai">
      {result.score != null ? <div className="ig-ai-score"><span>{result.score}</span>/10</div> : null}
      {result.summary ? <p className="ig-ai-summary">{result.summary}</p> : null}
      {result.hook ? (
        <div className="ig-ai-block">
          <h4>The first seconds</h4>
          <p>{result.hook}</p>
        </div>
      ) : null}
      <div className="ig-review-verdicts">
        {result.strengths?.length ? (
          <section className="ig-verdict ig-verdict-good">
            <h4><ArrowUpRight size={15} /> Working</h4>
            <ul>{result.strengths.map((s) => <li key={s}>{s}</li>)}</ul>
          </section>
        ) : null}
        {result.improvements?.length ? (
          <section className="ig-verdict ig-verdict-weak">
            <h4><ArrowDownRight size={15} /> To change</h4>
            <ul>{result.improvements.map((s) => <li key={s.issue}><strong>{s.at ? `${s.at} — ` : ""}{s.issue}</strong> {s.fix}</li>)}</ul>
          </section>
        ) : null}
      </div>
      {result.caption_ideas?.length ? (
        <div className="ig-ai-block">
          <h4>Caption ideas</h4>
          <ul>{result.caption_ideas.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}
