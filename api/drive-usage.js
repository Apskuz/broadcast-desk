// Reports what the app is actually storing in the team's Drive folder, so the
// lead can see how much space is in use and whether any files were left behind
// by a failed or interrupted cleanup.

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  try {
    const clientEmail = process.env.GDRIVE_CLIENT_EMAIL;
    const privateKey = (process.env.GDRIVE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
    const rootFolderId = process.env.GDRIVE_FOLDER_ID;
    if (!clientEmail || !privateKey || !rootFolderId) {
      return res.status(500).json({ error: "Google Drive isn't connected yet — missing server configuration." });
    }

    const accessToken = await getAccessToken(clientEmail, privateKey);
    const files = [];
    await walk(accessToken, rootFolderId, "", files, 0);

    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    return res.status(200).json({ totalBytes, fileCount: files.length, files });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}

async function walk(accessToken, folderId, prefix, out, depth) {
  if (depth > 4) return;
  let pageToken = null;
  do {
    const q = `'${folderId}' in parents and trashed = false`;
    const url =
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}` +
      `&fields=nextPageToken,files(id,name,size,mimeType)&pageSize=200&supportsAllDrives=true` +
      `&includeItemsFromAllDrives=true&corpora=allDrives${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await r.json();
    if (!r.ok) throw new Error("Couldn't list the Drive folder: " + JSON.stringify(data));

    for (const f of data.files || []) {
      if (f.mimeType === "application/vnd.google-apps.folder") {
        await walk(accessToken, f.id, `${prefix}${f.name}/`, out, depth + 1);
      } else {
        out.push({ id: f.id, name: f.name, size: Number(f.size || 0), path: prefix });
      }
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken);
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
