export default async function handler(req, res) {
  const refreshToken = req.query.refresh_token;
  if (!refreshToken) {
    return res.status(400).json({ error: "Missing refresh token" });
  }

  const clientId = process.env.BOX_CLIENT_ID;
  const clientSecret = process.env.BOX_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: "Missing BOX_CLIENT_ID or BOX_CLIENT_SECRET environment variable on Vercel" });
  }

  try {
    const tokenUrl = "https://api.box.com/oauth2/token";
    const params = new URLSearchParams();
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", refreshToken);
    params.append("client_id", clientId);
    params.append("client_secret", clientSecret);

    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = await tokenRes.json();

    if (tokenRes.ok) {
      return res.status(200).json(data);
    } else {
      return res.status(tokenRes.status).json({ error: data });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message || e });
  }
}
