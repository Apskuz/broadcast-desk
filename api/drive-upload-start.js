// Runs server-side on Vercel — this is where the Google service account credentials
// stay secret. It does NOT receive the actual file: it just authorizes an upload
// session, and the browser uploads the real bytes straight to Google afterward.
//
// Files land in <root>/<uploader's name>/Photos or Videos, created on demand, so
// the shared Drive stays organized instead of one flat dumping folder.

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { filename, mimeType, size, profile } = req.body || {};
    if (!filename || !size) {
      return res.status(400).json({ error: "Missing filename or size" });
    }

    const clientEmail = process.env.GDRIVE_CLIENT_EMAIL;
    const privateKey = (process.env.GDRIVE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
    const rootFolderId = process.env.GDRIVE_FOLDER_ID;

    if (!clientEmail || !privateKey || !rootFolderId) {
      return res.status(500).json({ error: "Google Drive isn't connected yet — missing server configuration." });
    }

    const accessToken = await getAccessToken(clientEmail, privateKey);
    const targetFolderId = await resolveUploadFolder(accessToken, rootFolderId, profile, mimeType);

    const driveRes = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType || "application/octet-stream",
        "X-Upload-Content-Length": String(size),
      },
      body: JSON.stringify({ name: filename, parents: [targetFolderId] }),
    });

    if (!driveRes.ok) {
      const text = await driveRes.text();
      return res.status(500).json({ error: "Google Drive rejected the upload request: " + text });
    }

    const sessionUrl = driveRes.headers.get("location");
    if (!sessionUrl) {
      return res.status(500).json({ error: "Drive didn't return an upload session." });
    }

    return res.status(200).json({ sessionUrl, folderId: targetFolderId });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}

// <root>/<person>/Photos or Videos — found or created as needed.
async function resolveUploadFolder(accessToken, rootFolderId, profile, mimeType) {
  const personName = (profile || "Unsorted").trim() || "Unsorted";
  const typeName = (mimeType || "").startsWith("image/") ? "Photos" : "Videos";
  const personFolderId = await findOrCreateFolder(accessToken, rootFolderId, personName);
  return findOrCreateFolder(accessToken, personFolderId, typeName);
}

async function findOrCreateFolder(accessToken, parentId, name) {
  const safeName = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const q = `name = '${safeName}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const listUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`;
  const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const listData = await listRes.json();
  if (!listRes.ok) throw new Error("Couldn't look up a Drive folder: " + JSON.stringify(listData));
  if (listData.files && listData.files[0]) return listData.files[0].id;

  const createRes = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  const createData = await createRes.json();
  if (!createRes.ok) throw new Error("Couldn't create a Drive folder: " + JSON.stringify(createData));
  return createData.id;
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
