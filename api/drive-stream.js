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

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: "Missing fileId" });

    const clientEmail = process.env.GDRIVE_CLIENT_EMAIL;
    const privateKey = (process.env.GDRIVE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
    if (!clientEmail || !privateKey) {
      return res.status(500).json({ error: "Google Drive isn't connected yet — missing server configuration." });
    }

    const accessToken = await getAccessToken(clientEmail, privateKey);

    const headers = { Authorization: `Bearer ${accessToken}` };
    if (req.headers.range) headers.Range = req.headers.range;

    const driveRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
      { headers }
    );

    if (!driveRes.ok && driveRes.status !== 206) {
      const text = await driveRes.text().catch(() => "");
      return res.status(driveRes.status).json({ error: "Couldn't stream the file: " + text });
    }

    res.status(driveRes.status);
    const passthrough = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"];
    for (const h of passthrough) {
      const v = driveRes.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!driveRes.headers.get("accept-ranges")) res.setHeader("Accept-Ranges", "bytes");

    if (req.method === "HEAD" || !driveRes.body) {
      return res.end();
    }

    const { Readable } = await import("stream");
    Readable.fromWeb(driveRes.body).pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: String(err) });
    else res.end();
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
