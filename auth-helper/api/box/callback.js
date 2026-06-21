export default async function handler(req, res) {
  const code = req.query.code;
  if (!code) {
    return res.status(400).json({ error: "Missing authorization code" });
  }

  const clientId = process.env.BOX_CLIENT_ID;
  const clientSecret = process.env.BOX_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: "Missing BOX_CLIENT_ID or BOX_CLIENT_SECRET environment variable on Vercel" });
  }

  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const redirectUri = `${protocol}://${host}/api/box/callback`;

  try {
    const tokenUrl = "https://api.box.com/oauth2/token";
    const params = new URLSearchParams();
    params.append("grant_type", "authorization_code");
    params.append("code", code);
    params.append("client_id", clientId);
    params.append("client_secret", clientSecret);
    params.append("redirect_uri", redirectUri);

    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = await tokenRes.json();

    if (tokenRes.ok) {
      const obsidianUrl = `obsidian://sync-save-auth?provider=box&access_token=${encodeURIComponent(data.access_token)}&refresh_token=${encodeURIComponent(data.refresh_token)}`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(`
        <html>
          <head>
            <title>授權成功</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #0f172a; color: #f8fafc; text-align: center; }
              .card { background: #1e293b; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); max-width: 400px; }
              h1 { color: #38bdf8; margin-top: 0; }
              a { display: inline-block; margin-top: 1rem; padding: 10px 20px; background: #38bdf8; color: #0f172a; text-decoration: none; border-radius: 6px; font-weight: bold; }
            </style>
          </head>
          <body>
            <div class="card">
              <h1>授權成功！</h1>
              <p>正在為您開啟 Obsidian 並匯入金鑰...</p>
              <p>如果瀏覽器沒有自動開啟，請點擊下方按鈕：</p>
              <a href="${obsidianUrl}">開啟 Obsidian</a>
            </div>
            <script>
              window.location.href = "${obsidianUrl}";
            </script>
          </body>
        </html>
      `);
    } else {
      return res.status(tokenRes.status).json({ error: data });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message || e });
  }
}
