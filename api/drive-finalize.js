// Runs after the browser finishes uploading a file directly to Drive. Sets the file
// to "anyone with the link can view" so the in-app preview works for every teammate
// without each of them needing individual Drive access, then returns the link.
//
// Google's resumable-upload PUT often omits the CORS header on its final response,
// so the browser can't read it even when the upload succeeded — the browser only
// knows an error happened, not a real fileId. When that happens we're called with
// a filename instead, and look the file up ourselves (server-to-server calls aren't
// subject to that CORS restriction). For a larger file, Drive's search index can
// take a few seconds to catch up after the bytes finish landing, so this retries
// with backoff instead of giving up on the first empty result.

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { fileId: providedFileId, filename, folderId: providedFolderId } = req.body || {};
    if (!providedFileId && !filename) return res.status(400).json({ error: "Missing fileId or filename" });

    const clientEmail = process.env.GDRIVE_CLIENT_EMAIL;
    const privateKey = (process.env.GDRIVE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
    const folderId = providedFolderId || process.env.GDRIVE_FOLDER_ID;
    if (!clientEmail || !privateKey) {
      return res.status(500).json({ error: "Google Drive isn't connected yet — missing server configuration." });
    }

    const accessToken = await getAccessToken(clientEmail, privateKey);

    let fileId = providedFileId;
    if (!fileId) {
      const delays = [0, 1500, 2500, 4000, 6000]; // ~14s total, well under the 30s limit above
      for (const delay of delays) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        fileId = await findRecentFile(accessToken, folderId, filename);
        if (fileId) break;
      }
      if (!fileId) {
        return res.status(404).json({ error: "Couldn't find the uploaded file in Drive — it may not have finished uploading." });
      }
    }

    const permRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?supportsAllDrives=true`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    });

    if (!permRes.ok) {
      const text = await permRes.text();
      return res.status(500).json({ error: "Couldn't make the file viewable: " + text });
    }

    return res.status(200).json({ link: `https://drive.google.com/file/d/${fileId}/view` });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}

// Finds the newest file with this name in the upload folder — used when we can't
// read the real fileId back from the browser (see comment at the top of the file).
async function findRecentFile(accessToken, folderId, filename) {
  const q = `name = '${filename.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&orderBy=createdTime desc&pageSize=1&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) throw new Error("Couldn't search Drive for the uploaded file: " + JSON.stringify(data));
  return data.files && data.files[0] ? data.files[0].id : null;
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
