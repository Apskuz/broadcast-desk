// Streams a video's actual bytes from Drive through our own server, instead of
// embedding Google's Drive preview page. That preview page isn't built for small
// mobile iframes — it renders the video stretched/cropped ("zoomed in") and is
// heavy to load. A plain <video> tag pointed at this endpoint gets the real file,
// sized and controlled by the browser's own native player.
//
// Supports Range requests so seeking/scrubbing works and the browser doesn't have
// to download the whole file up front.

export const config = {
  maxDuration: 60,
};

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB per range request

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { fileId, thumb, size } = req.query;
    if (!fileId) return res.status(400).json({ error: "Missing fileId" });

    const clientEmail = process.env.GDRIVE_CLIENT_EMAIL;
    const privateKey = (process.env.GDRIVE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
    if (!clientEmail || !privateKey) {
      return res.status(500).json({ error: "Google Drive isn't connected yet — missing server configuration." });
    }

    const accessToken = await getAccessToken(clientEmail, privateKey);

    // A file id always points at the same bytes (a new upload gets a new id),
    // so this can be cached hard. Repeat views then cost no bandwidth at all,
    // which matters because every byte served here counts against the hosting
    // plan's monthly transfer allowance.
    const CACHE = "private, max-age=31536000, immutable";

    // Thumbnail mode: hand back Drive's own small preview rather than the full
    // file. A board full of phone photos at ~4MB each would otherwise transfer
    // tens of megabytes just to fill 90px squares.
    if (thumb) {
      const served = await serveThumbnail(accessToken, fileId, size || "s400", res, CACHE);
      if (served) return;
      // No preview available — stop here rather than falling through, or an
      // <img> asking for a thumbnail would quietly pull down a whole video.
      return res.status(404).json({ error: "No thumbnail for this file" });
    }

    const headers = { Authorization: `Bearer ${accessToken}` };
    // A <video> normally opens with "bytes=0-", i.e. "send me the whole file".
    // Serving that in one shot means a big video has to finish streaming inside
    // this function's time limit or playback dies partway through. Capping an
    // open-ended range turns it into a series of quick chunked requests instead,
    // so playback starts fast and no single request can run long enough to be
    // cut off. Images don't send a Range header at all, so they still come back
    // whole in one response.
    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      if (match) {
        const start = Number(match[1]);
        const requestedEnd = match[2] ? Number(match[2]) : null;
        const cappedEnd = start + CHUNK_SIZE - 1;
        const end = requestedEnd == null ? cappedEnd : Math.min(requestedEnd, cappedEnd);
        headers.Range = `bytes=${start}-${end}`;
      } else {
        headers.Range = range;
      }
    }

    const driveRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
      { headers }
    );

    if (!driveRes.ok && driveRes.status !== 206) {
      const text = await driveRes.text().catch(() => "");
      return res.status(driveRes.status).json({ error: "Couldn't stream the file: " + text });
    }

    res.status(driveRes.status);
    const passthrough = ["content-type", "content-length", "content-range", "accept-ranges"];
    for (const h of passthrough) {
      const v = driveRes.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!driveRes.headers.get("accept-ranges")) res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", CACHE);

    if (req.method === "HEAD" || !driveRes.body) {
      return res.end();
    }

    const { Readable } = await import("stream");
    const stream = Readable.fromWeb(driveRes.body);
    // Closing a video mid-download aborts the response — tear the stream down
    // rather than letting an unhandled error take the function with it.
    stream.on("error", () => res.end());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: String(err) });
    else res.end();
  }
}

// Drive generates its own small preview for images and a poster frame for
// videos. Returns false if there isn't one, so the caller can fall back to
// streaming the real file.
async function serveThumbnail(accessToken, fileId, size, res, cacheHeader) {
  try {
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=thumbnailLink&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!metaRes.ok) return false;
    const meta = await metaRes.json();
    if (!meta.thumbnailLink) return false;

    const thumbUrl = meta.thumbnailLink.replace(/=s\d+(-c)?$/, `=${size}`);
    const thumbRes = await fetch(thumbUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!thumbRes.ok) return false;

    res.status(200);
    res.setHeader("Content-Type", thumbRes.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", cacheHeader);
    const buf = Buffer.from(await thumbRes.arrayBuffer());
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

async function getAccessToken(clientEmail, privateKey) {
  const crypto = await import("crypto");
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const base64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${base64url(header)}.${base64url(payload)}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(privateKey, "base64url");
  const jwt = `${unsigned}.${signature}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) throw new Error("Could not authenticate with Google: " + JSON.stringify(tokenData));
  return tokenData.access_token;
}
