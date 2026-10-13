// What's said in a video, transcribed on this device with Whisper.
//
// Runs in the browser like the background remover: the model (~80MB) is
// fetched the first time someone asks for a transcript and cached by the
// browser after that; the audio never leaves the device and there's no
// per-use cost. Whisper "base" is the size that still runs at a usable speed
// on a phone; it handles Finnish and English, Finnish a little less cleanly.
const MODEL = "onnx-community/whisper-base";
const LANGS = { auto: null, fi: "finnish", en: "english" };

let transcriberPromise = null;
function loadTranscriber(onProgress) {
  if (!transcriberPromise) {
    transcriberPromise = import("@huggingface/transformers").then(({ pipeline }) =>
      pipeline("automatic-speech-recognition", MODEL, {
        dtype: "q8",
        device: "wasm",
        progress_callback: (p) => {
          if (p.status === "progress" && p.total) onProgress?.({ stage: "download", loaded: p.loaded, total: p.total, file: p.file });
        },
      })
    ).catch((err) => {
      transcriberPromise = null; // let the next attempt retry the download
      throw err;
    });
  }
  return transcriberPromise;
}

// Whisper wants 16kHz mono samples; resample whatever the video carries.
async function speechSamples(buffer) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  try {
    const decoded = await ctx.decodeAudioData(buffer);
    const rate = 16000;
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  } finally {
    ctx.close().catch(() => {});
  }
}

const wordsIn = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0);

// buffer: the video file's bytes. language: "auto" | "fi" | "en".
export async function transcribe(buffer, { language = "auto", onProgress } = {}) {
  onProgress?.({ stage: "audio" });
  let samples;
  try {
    samples = await speechSamples(buffer);
  } catch {
    return { status: "noaudio" };
  }
  const transcriber = await loadTranscriber(onProgress);
  onProgress?.({ stage: "listening" });
  const out = await transcriber(samples, {
    language: LANGS[language] ?? null,
    task: "transcribe",
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
  });
  // Whisper fills silence or music with stock phrases; drop the usual ones.
  const junk = /^\s*(\[.*\]|\(.*\)|♪+|thank you\.?|thanks for watching!?|kiitos\.?)\s*$/i;
  const chunks = (out.chunks || [])
    .map((c) => ({ from: c.timestamp?.[0] ?? 0, to: c.timestamp?.[1] ?? null, text: (c.text || "").trim() }))
    .filter((c) => c.text && !junk.test(c.text));
  const text = chunks.map((c) => c.text).join(" ").trim();
  if (!text) return { status: "nospeech" };

  const words = wordsIn(text);
  const first = chunks[0];
  const last = chunks[chunks.length - 1];
  const spokenFor = Math.max(1, (last.to ?? last.from + 2) - first.from);
  // Roughly the first three seconds of speech, for judging the spoken hook.
  const opening = chunks.filter((c) => c.from < first.from + 3).map((c) => c.text).join(" ");
  return {
    status: "ok",
    language,
    text: text.slice(0, 4000),
    chunks: chunks.slice(0, 80),
    words,
    firstWordAt: first.from,
    wordsPerMinute: Math.round((words / spokenFor) * 60),
    opening: opening.slice(0, 240),
  };
}
