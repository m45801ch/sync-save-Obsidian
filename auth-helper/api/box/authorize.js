export default function handler(req, res) {
  const clientId = process.env.BOX_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: "Missing BOX_CLIENT_ID environment variable on Vercel" });
  }

  // 自動取得當前 Vercel 部署的 host 名稱作為 redirect_uri
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const redirectUri = `${protocol}://${host}/api/box/callback`;

  const authUrl = `https://account.box.com/api/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(authUrl);
}
