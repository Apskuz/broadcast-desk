// Runs server-side on Vercel — this is where the Google service account credentials
// stay secret. It does NOT receive the actual file: it just authorizes an upload
// session, and the browser uploads the real bytes straight to Google afterward.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { filename, mimeType, size } = req.body || {};
    if (!filename || !size) {
      return res.status(400).json({ error: "Missing filename or size" });
    }

    const clientEmail = process.env.GDRIVE_CLIENT_EMAIL;
    const privateKey = (process.env.GDRIVE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
    const folderId = process.env.GDRIVE_FOLDER_ID;

    if (!clientEmail || !privateKey || !folderId) {
      return res.status(500).json({ error: "Google Drive isn't connected yet — missing server configuration." });
    }

    const accessToken = await getAccessToken(clientEmail, privateKey);

    const driveRes = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType || "application/octet-stream",
        "X-Upload-Content-Length": String(size),
      },
      body: JSON.stringify({ name: filename, parents: [folderId] }),
    });

    if (!driveRes.ok) {
      const text = await driveRes.text();
      return res.status(500).json({ error: "Google Drive rejected the upload request: " + text });
    }

    const sessionUrl = driveRes.headers.get("location");
    if (!sessionUrl) {
      return res.status(500).json({ error: "Drive didn't return an upload session." });
    }

    return res.status(200).json({ sessionUrl });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}

// Minimal service-account JWT signing using only Node's built-in crypto — no extra
// dependency needed for this one function.
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
