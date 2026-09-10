// Runs server-side on Vercel. Deletes a file from the shared Drive folder once
// its content has been published, so the team's Drive doesn't fill up with
// videos/photos nobody needs anymore.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { fileId } = req.body || {};
    if (!fileId) return res.status(400).json({ error: "Missing fileId" });

    const clientEmail = process.env.GDRIVE_CLIENT_EMAIL;
    const privateKey = (process.env.GDRIVE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
    if (!clientEmail || !privateKey) {
      return res.status(500).json({ error: "Google Drive isn't connected yet — missing server configuration." });
    }

    const accessToken = await getAccessToken(clientEmail, privateKey);

    const delRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // Already gone is fine — the outcome we want either way.
    if (!delRes.ok && delRes.status !== 404) {
      const text = await delRes.text();
      return res.status(500).json({ error: "Couldn't delete the file: " + text });
    }

    return res.status(200).json({ deleted: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
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
