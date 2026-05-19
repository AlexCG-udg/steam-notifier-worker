/**
 * Steam Notifier – Cloudflare Worker
 * Migrated from Practice 1 (PHP/Python + SQLite) to Workers + KV
 *
 * KV key schema
 *   user:{username}   → { passwordHash, salt, email }
 *   token:{token}     → { username, expiresAt }
 *   games:{username}  → [ appid, ... ]
 *
 * Secrets (set via Wrangler):
 *   RESEND_API_KEY
 */

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Generate a 32-char hex token */
function generateToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generate a random hex salt */
function generateSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** PBKDF2-based password hashing (Web Crypto – available in Workers) */
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Validate token → username, or null if invalid/expired.
 * Expired tokens are lazily deleted.
 */
async function validateToken(env, token) {
  if (!token) return null;
  const data = await env.STEAM_KV.get(`token:${token}`, "json");
  if (!data) return null;
  if (Date.now() > data.expiresAt) {
    await env.STEAM_KV.delete(`token:${token}`);
    return null;
  }
  return data.username;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** POST /register  { username, password } */
async function handleRegister(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }

  const { username, password } = body;
  if (!username || !password) return jsonResponse({ error: "Username and password are required" }, 400);

  const existing = await env.STEAM_KV.get(`user:${username}`);
  if (existing) return jsonResponse({ error: "User already exists" }, 409);

  const salt = generateSalt();
  const passwordHash = await hashPassword(password, salt);

  await env.STEAM_KV.put(`user:${username}`, JSON.stringify({ passwordHash, salt, email: null }));
  return jsonResponse({ message: "User registered successfully" }, 201);
}

/** POST /login  { username, password } → { token } */
async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }

  const { username, password } = body;
  if (!username || !password) return jsonResponse({ error: "Username and password are required" }, 400);

  const userData = await env.STEAM_KV.get(`user:${username}`, "json");
  if (!userData) return jsonResponse({ error: "Invalid credentials" }, 401);

  const hash = await hashPassword(password, userData.salt);
  if (hash !== userData.passwordHash) return jsonResponse({ error: "Invalid credentials" }, 401);

  const token = generateToken();
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 h

  // Store token in KV with automatic 24 h TTL
  await env.STEAM_KV.put(
    `token:${token}`,
    JSON.stringify({ username, expiresAt }),
    { expirationTtl: 86400 }
  );

  return jsonResponse({ token: `token:${token}` });
}

/** POST /logout?token=TOKEN */
async function handleLogout(_request, env, url) {
  const token = url.searchParams.get("token");
  const username = await validateToken(env, token);
  if (!username) return jsonResponse({ error: "Invalid or expired token" }, 401);

  await env.STEAM_KV.delete(`token:${token}`);
  return jsonResponse({ message: "Logged out successfully" });
}

/** PUT /email?token=TOKEN  { email } */
async function handleSetEmail(request, env, url) {
  const token = url.searchParams.get("token");
  const username = await validateToken(env, token);
  if (!username) return jsonResponse({ error: "Invalid or expired token" }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }

  const { email } = body;
  if (!email) return jsonResponse({ error: "Email is required" }, 400);

  const userData = await env.STEAM_KV.get(`user:${username}`, "json");
  await env.STEAM_KV.put(`user:${username}`, JSON.stringify({ ...userData, email }));

  return jsonResponse({ message: "Email updated successfully" });
}

/** POST /games?token=TOKEN  { appid } */
async function handleAddGame(request, env, url) {
  const token = url.searchParams.get("token");
  const username = await validateToken(env, token);
  if (!username) return jsonResponse({ error: "Invalid or expired token" }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }

  const appid = Number(body.appid);
  if (!appid) return jsonResponse({ error: "Valid appid is required" }, 400);

  const games = (await env.STEAM_KV.get(`games:${username}`, "json")) || [];
  if (games.includes(appid)) return jsonResponse({ error: "Game already in list" }, 409);

  games.push(appid);
  await env.STEAM_KV.put(`games:${username}`, JSON.stringify(games));

  return jsonResponse({ message: "Game added", appid }, 201);
}

/** GET /games?token=TOKEN */
async function handleListGames(_request, env, url) {
  const token = url.searchParams.get("token");
  const username = await validateToken(env, token);
  if (!username) return jsonResponse({ error: "Invalid or expired token" }, 401);

  const games = (await env.STEAM_KV.get(`games:${username}`, "json")) || [];
  return jsonResponse({ games });
}

/** DELETE /games/:appid?token=TOKEN */
async function handleDeleteGame(_request, env, url) {
  const token = url.searchParams.get("token");
  const username = await validateToken(env, token);
  if (!username) return jsonResponse({ error: "Invalid or expired token" }, 401);

  const appid = Number(url.pathname.split("/")[2]);
  const games = (await env.STEAM_KV.get(`games:${username}`, "json")) || [];
  const updated = games.filter((id) => id !== appid);

  if (updated.length === games.length) return jsonResponse({ error: "Game not found" }, 404);

  await env.STEAM_KV.put(`games:${username}`, JSON.stringify(updated));
  return jsonResponse({ message: "Game removed", appid });
}

/** POST /notify?token=TOKEN  – trigger notification for the authenticated user */
async function handleNotify(_request, env, url) {
  const token = url.searchParams.get("token");
  const username = await validateToken(env, token);
  if (!username) return jsonResponse({ error: "Invalid or expired token" }, 401);

  const result = await sendUserNotification(env, username);
  if (!result.ok) return jsonResponse({ error: result.error }, 500);
  return jsonResponse({ message: "Notification sent" });
}

// ---------------------------------------------------------------------------
// Steam & email helpers
// ---------------------------------------------------------------------------

async function getSteamPlayers(appid) {
  try {
    const res = await fetch(
      `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appid}`
    );
    const data = await res.json();
    return data.response?.player_count ?? 0;
  } catch {
    return 0;
  }
}

async function getSteamGameName(appid) {
  try {
    const res = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic`
    );
    const data = await res.json();
    return data[appid]?.data?.name || `AppID ${appid}`;
  } catch {
    return `AppID ${appid}`;
  }
}

function buildEmailHtml(games, date) {
  const rows = games
    .map(
      ({ name, players }) => `
      <tr>
        <td style="border:1px solid #ccc;padding:8px 14px">${name}</td>
        <td style="border:1px solid #ccc;padding:8px 14px;text-align:right">${players.toLocaleString("ca-ES")}</td>
      </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="ca">
<head><meta charset="UTF-8"></head>
<body style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="color:#1b2838">Steam Notifier · ${date}</h2>
  <table style="border-collapse:collapse;width:100%">
    <thead>
      <tr>
        <th style="border:1px solid #ccc;padding:8px 14px;background:#f5f5f5;text-align:left">Joc</th>
        <th style="border:1px solid #ccc;padding:8px 14px;background:#f5f5f5;text-align:right">Jugadors</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="color:#888;font-size:12px;margin-top:20px">Notificació automàtica de Steam Notifier</p>
</body>
</html>`;
}

async function sendResendEmail(apiKey, to, subject, html) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: "Steam Notifier <onboarding@resend.dev>",
      to: [to],
      subject,
      html,
    }),
  });
  return res;
}

/**
 * Fetch player counts for all games of a user and send an email.
 * Returns { ok: true } or { ok: false, error }
 */
async function sendUserNotification(env, username) {
  const userData = await env.STEAM_KV.get(`user:${username}`, "json");
  if (!userData?.email) return { ok: false, error: "No email configured for this user" };

  const appids = (await env.STEAM_KV.get(`games:${username}`, "json")) || [];
  if (appids.length === 0) return { ok: false, error: "No games in list" };

  // Fetch name + player count in parallel
  const games = await Promise.all(
    appids.map(async (appid) => {
      const [players, name] = await Promise.all([getSteamPlayers(appid), getSteamGameName(appid)]);
      return { appid, name, players };
    })
  );

  const date = new Date().toLocaleDateString("ca-ES");
  const html = buildEmailHtml(games, date);
  const subject = `Steam Notifier – ${date}`;

  const res = await sendResendEmail(env.RESEND_API_KEY, userData.email, subject, html);
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, error: `Resend error ${res.status}: ${body}` };
  }
  return { ok: true };
}

/** Called by the cron trigger – notify every registered user that has an email */
async function sendAllNotifications(env) {
  const list = await env.STEAM_KV.list({ prefix: "user:" });

  await Promise.allSettled(
    list.keys.map(({ name }) => {
      const username = name.slice("user:".length);
      return sendUserNotification(env, username);
    })
  );
}

// ---------------------------------------------------------------------------
// Worker entry-point
// ---------------------------------------------------------------------------

export default {
  /** Handle HTTP requests */
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const { method, pathname: path } = Object.assign(request, { pathname: url.pathname });

    // Normalise pathname from URL object
    const p = url.pathname;

    try {
      if (p === "/register" && method === "POST") return handleRegister(request, env);
      if (p === "/login"    && method === "POST") return handleLogin(request, env);
      if (p === "/logout"   && method === "POST") return handleLogout(request, env, url);
      if (p === "/email"    && method === "PUT")  return handleSetEmail(request, env, url);
      if (p === "/games"    && method === "POST") return handleAddGame(request, env, url);
      if (p === "/games"    && method === "GET")  return handleListGames(request, env, url);
      if (/^\/games\/\d+$/.test(p) && method === "DELETE") return handleDeleteGame(request, env, url);
      if (p === "/notify"   && method === "POST") return handleNotify(request, env, url);
      if (p === "/notify"   && method === "POST") return handleNotify(request, env, url);
      if (p === "/debug-key" && method === "GET") return jsonResponse({ key: env.RESEND_API_KEY ? env.RESEND_API_KEY.substring(0, 10) + "..." : "NOT SET" });
      return jsonResponse({ error: "Not found" }, 404);
      return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
      return jsonResponse({ error: "Internal server error" }, 500);
    }
  },

  /** Cron trigger – runs daily at 20:00 UTC */
  async scheduled(_event, env, _ctx) {
    await sendAllNotifications(env);
  },
};
