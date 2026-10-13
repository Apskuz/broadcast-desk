// AI review for the Analytics screen: either a video someone is about to post
// (eight still frames plus what the browser measured) or a post that's already
// up (its cover image, caption and numbers). Returns plain-language feedback
// in a fixed shape the page can lay out.
//
// Needs ANTHROPIC_API_KEY in Vercel's environment variables. A review costs a
// few cents; the limits below keep anyone who finds this URL from running up
// the bill.
import Anthropic from "@anthropic-ai/sdk";

export const config = { maxDuration: 60 };

const MODEL = "claude-opus-5-5";
const MAX_FRAMES = 8;
const MAX_FRAME_BYTES = 400 * 1024;
// Instagram's own image hosts only, so this can't be pointed at anything else.
const IMAGE_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

// Best effort per warm instance: enough to stop a loop hammering it.
const recent = [];
const PER_HOUR = 30;

const FEEDBACK_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", description: "1-10: how ready this is to perform well, judged against the account's own norms." },
    summary: { type: "string", description: "Two or three sentences: the overall verdict and the single most important change." },
    hook: { type: "string", description: "What the first 1-2 seconds (or the cover, for a still post) do to stop someone scrolling, and how to make them stronger." },
    strengths: { type: "array", items: { type: "string" }, description: "Specific things that are working. Two to four." },
    improvements: {
      type: "array",
      description: "Specific changes, most important first. Two to five.",
      items: {
        type: "object",
        properties: {
          issue: { type: "string", description: "What's wrong, in a short phrase." },
          fix: { type: "string", description: "Exactly what to do about it." },
          at: { type: "string", description: "Timestamp like 0:03 if it concerns one moment, otherwise empty." },
        },
        required: ["issue", "fix", "at"],
        additionalProperties: false,
      },
    },
    caption_ideas: { type: "array", items: { type: "string" }, description: "Up to three improved first lines for the caption, in the caption's language. Empty if the caption is already strong." },
  },
  required: ["score", "summary", "hook", "strengths", "improvements", "caption_ideas"],
  additionalProperties: false,
};

const SYSTEM = `You review Instagram content for a small team that runs one account. You think like an experienced short-form video editor and an Instagram strategist at once, and you give feedback the team can act on today.

How to judge:
- Measurements you're given come from software that watched or analysed the real thing. Treat them as facts; don't contradict them. Use the frames and image for what numbers can't capture: is the opening visually interesting, is there a clear subject, is on-screen text readable, does it look like it belongs in a feed.
- Frames are stills. You can't hear the audio or see motion between frames, so lean on the measurements for sound and pace, and say so when something can't be judged from stills.
- Instagram covers the bottom ~20% of a reel and the right edge with its buttons and caption, and the top ~12% with the header. Flag text or faces sitting there.
- Judge against the account's own numbers when they're given (how long people watch, what its best posts did), not against generic benchmarks. Don't invent statistics.
- Be specific: name the frame or moment, say exactly what to change. No generic advice that would apply to any video.
- Write in English, plainly and briefly. Caption ideas go in the caption's own language.`;

function pruneRate() {
  const hourAgo = Date.now() - 3600000;
  while (recent.length && recent[0] < hourAgo) recent.shift();
  return recent.length < PER_HOUR;
}

async function imageFromUrl(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  if (!IMAGE_HOSTS.test(host)) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  const type = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
  if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 5 * 1024 * 1024) return null;
  return { type: "image", source: { type: "base64", media_type: type, data: buf.toString("base64") } };
}

function videoContent(body) {
  const frames = Array.isArray(body.frames) ? body.frames.slice(0, MAX_FRAMES) : [];
  if (!frames.length) throw Object.assign(new Error("No frames were sent."), { status: 400 });
  const content = [];
  for (const f of frames) {
    if (typeof f.data !== "string" || f.data.length > MAX_FRAME_BYTES * 1.4) throw Object.assign(new Error("A frame is too large."), { status: 400 });
    content.push({ type: "text", text: `Frame at ${Number(f.t) || 0}s:` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.data } });
  }
  content.push({
    type: "text",
    text: [
      `This is a ${body.format === "feed" ? "feed video" : body.format === "story" ? "story" : "reel"} that hasn't been posted yet.`,
      `Measurements: ${JSON.stringify(body.stats || {})}`,
      body.checks?.length ? `Automatic checks already shown to the team:\n- ${body.checks.slice(0, 30).join("\n- ")}` : "",
      body.account ? `The account's own reels: ${JSON.stringify(body.account)}` : "There isn't enough account history to compare against.",
      `Planned caption: ${body.caption ? JSON.stringify(String(body.caption).slice(0, 2200)) : "(none yet)"}`,
      "Review it. Add what the automatic checks can't see rather than repeating them.",
    ].filter(Boolean).join("\n\n"),
  });
  return content;
}

async function postContent(body) {
  const content = [];
  const image = body.imageUrl ? await imageFromUrl(body.imageUrl) : null;
  if (image) {
    content.push({ type: "text", text: "The post's cover image:" });
    content.push(image);
  }
  content.push({
    type: "text",
    text: [
      `This ${body.kind || "post"} (${body.format || "unknown format"}) is already live; posted ${body.postedAt || "at an unknown time"}${body.slot ? ` (${body.slot})` : ""}.`,
      image ? "" : "The image couldn't be loaded, so judge from the numbers and caption only.",
      body.rank ? `Rank among the 30 comparable posts from around the same time: ${body.rank}.` : "",
      `Its numbers next to the account's typical ${body.kind || "post"} from around the same time: ${JSON.stringify(body.measures || [])}`,
      `Caption: ${JSON.stringify(String(body.caption || "").slice(0, 2200))}`,
      body.bestCaptions?.length ? `Captions of the best-reaching comparable posts:\n- ${body.bestCaptions.slice(0, 3).map((c) => JSON.stringify(c)).join("\n- ")}` : "",
      "Explain why it performed the way it did, and what to do differently on the next one. For a posted video you only have the cover, so say what you can't judge.",
    ].filter(Boolean).join("\n\n"),
  });
  return content;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "AI review isn't set up yet: add ANTHROPIC_API_KEY in Vercel → Settings → Environment Variables, then redeploy." });
  }
  if (!pruneRate()) return res.status(429).json({ error: "Lots of reviews in the last hour — try again in a little while." });
  recent.push(Date.now());

  try {
    const body = req.body || {};
    const content = body.mode === "post" ? await postContent(body) : videoContent(body);
    const client = new Anthropic();
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: FEEDBACK_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content }],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      return res.status(422).json({ error: "The AI declined to review this one." });
    }
    if (message.stop_reason === "max_tokens") {
      return res.status(502).json({ error: "The review came back cut off — try again." });
    }
    const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    let parsed;
    try { parsed = JSON.parse(text); } catch { return res.status(502).json({ error: "The review came back in an unexpected shape — try again." }); }
    return res.status(200).json(parsed);
  } catch (err) {
    if (err.status === 400 && !(err instanceof Anthropic.APIError)) return res.status(400).json({ error: err.message });
    if (err instanceof Anthropic.AuthenticationError) return res.status(503).json({ error: "The ANTHROPIC_API_KEY in Vercel was rejected — check it." });
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "The AI is busy right now — try again in a minute." });
    if (err instanceof Anthropic.BadRequestError) return res.status(400).json({ error: `The AI couldn't take this request: ${err.message}` });
    if (err instanceof Anthropic.APIError) return res.status(502).json({ error: `The AI service returned an error (${err.status}).` });
    return res.status(500).json({ error: String(err.message || err) });
  }
}
