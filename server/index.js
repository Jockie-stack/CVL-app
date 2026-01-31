import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { body, validationResult } from "express-validator";

import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import sanitizeHtml from "sanitize-html";
import sqlite3 from "sqlite3";

// Lazy load web-push (keeps server runnable even if dependency not installed yet)
let _webpush = null;
async function getWebPush() {
  if (_webpush) return _webpush;
  try {
    const m = await import("web-push");
    _webpush = m.default || m;
    return _webpush;
  } catch {
    return null;
  }
}

// ======================
// Env / config
// ======================
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-prod";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || ""; // bcrypt hash
const COOKIE_NAME = process.env.COOKIE_NAME || "cvl_admin";
const ORIGIN = process.env.CORS_ORIGIN || ""; // optional
const DB_PATH = process.env.DB_PATH || "./data.sqlite";
const IDEA_COOLDOWN_SEC = Number(process.env.IDEA_COOLDOWN_SEC || 60);

// Push (Web Push / VAPID)
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

// IMPORTANT: In production, set TRUST_PROXY=1 if behind a reverse proxy.
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");

// ======================
// DB (SQLite)
// ======================
const db = new sqlite3.Database(DB_PATH);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function initDb() {
  await run(`PRAGMA journal_mode = WAL;`);
  await run(`PRAGMA foreign_keys = ON;`);

  await run(`
    CREATE TABLE IF NOT EXISTS ideas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      category TEXT NOT NULL,
      urgency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'nouveau',
      device_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS poll (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      options_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS poll_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id INTEGER NOT NULL,
      option_index INTEGER NOT NULL,
      voter_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(poll_id, voter_hash),
      FOREIGN KEY(poll_id) REFERENCES poll(id) ON DELETE CASCADE
    );
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS info_blocks (
      key TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      url TEXT
    );
  `);


await run(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    subscription_json TEXT NOT NULL,
    device_hash TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
await run(`CREATE INDEX IF NOT EXISTS idx_push_device_hash ON push_subscriptions(device_hash);`);

await run(`
  CREATE TABLE IF NOT EXISTS daily_connections (
    day TEXT NOT NULL,
    device_hash TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY(day, device_hash)
  );
`);
await run(`CREATE INDEX IF NOT EXISTS idx_daily_connections_day ON daily_connections(day);`);

  // Seed info blocks inspired by the structure of the lycée site
  const defaults = [
    ["jpo", "Journées Portes Ouvertes (JPO) : informations à confirmer par l'établissement.", "https://lyceemauriac.fr/"],
    ["mini_stages", "Mini-stages en Seconde : découvrir des filières et options.", "https://lyceemauriac.fr/"],
    ["science_weekly", "Information scientifique de la semaine : résumé et lien vers la source.", "https://lyceemauriac.fr/"],
    ["cycle_mauriac", "Cycle Mauriac / expositions : conférences, rencontres, expositions.", "https://lyceemauriac.fr/"],
    ["region_aides", "Aides de la Région Nouvelle-Aquitaine : bourses, équipement, transports.", "https://lyceemauriac.fr/"]
  ];
  for (const [key, text, url] of defaults) {
    await run(
      `INSERT OR IGNORE INTO info_blocks(key, text, url) VALUES(?, ?, ?)`,
      [key, text, url]
    );
  }
}

// ======================
// Helpers
// ======================
function nowIso() {
  return new Date().toISOString();
}

function sha256(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function cleanText(str, maxLen) {
  const cleaned = sanitizeHtml(String(str || ""), { allowedTags: [], allowedAttributes: {} }).trim();
  if (maxLen && cleaned.length > maxLen) return cleaned.slice(0, maxLen);
  return cleaned;
}

function signAdminToken() {
  return jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: "8h" });
}

function setAuthCookie(res, token) {
  const isProd = process.env.NODE_ENV === "production";
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd, // set true in prod with HTTPS
    maxAge: 8 * 60 * 60 * 1000
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "lax" });
}

function requireAdmin(req, res, next) {
  try {
    const token = req.cookies[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: "Non authentifié" });
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload?.admin) return res.status(403).json({ error: "Accès refusé" });
    req.admin = true;
    next();
  } catch {
    return res.status(401).json({ error: "Session expirée" });
  }
}


// ======================
// Push helpers
// ======================
function canUsePushConfig() {
  return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
}

async function initWebPushIfConfigured() {
  if (!canUsePushConfig()) return null;
  const webpush = await getWebPush();
  if (!webpush) return null;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  return webpush;
}

async function sendPushToAll(payload) {
  if (!canUsePushConfig()) return { sent: 0, failed: 0, disabled: true, reason: "missing_vapid" };
  const webpush = await initWebPushIfConfigured();
  if (!webpush) return { sent: 0, failed: 0, disabled: true, reason: "missing_webpush_module" };

  const subs = await all(`SELECT endpoint, subscription_json FROM push_subscriptions`);
  let sent = 0;
  let failed = 0;

  for (const s of subs) {
    try {
      const subscription = JSON.parse(s.subscription_json);
      await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 60 * 60 });
      sent++;
    } catch (e) {
      failed++;
      const status = e?.statusCode;
      if (status === 404 || status === 410) {
        try { await run(`DELETE FROM push_subscriptions WHERE endpoint = ?`, [s.endpoint]); } catch (_) {}
      }
    }
  }

  return { sent, failed, disabled: false };
}

// ======================
// App + security middleware

// ======================
await initDb();

const app = express();
if (TRUST_PROXY) app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: false // simplest for a self-contained PWA (fonts inline etc.)
}));

app.use(express.json({ limit: "20kb" }));
app.use(cookieParser());

// CORS (optional)
app.use(cors({
  origin: ORIGIN ? ORIGIN.split(",").map(s => s.trim()) : false,
  credentials: true
}));

// Rate limits
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false
});
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api/public", publicLimiter);
app.use("/api/auth/login", loginLimiter);

// Simple anti-automation: require a device id header
app.use("/api", (req, res, next) => {
  const deviceId = req.get("X-Device-Id") || "";
  if (!deviceId || deviceId.length < 8 || deviceId.length > 200) {
    return res.status(400).json({ error: "En-tête X-Device-Id manquant" });
  }
  req.deviceHash = sha256(deviceId);
  next();
});


// Track daily connections (best-effort, one entry per device/day on GET /api/public/*)
app.use("/api/public", async (req, _res, next) => {
  if (req.method !== "GET") return next();
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  try {
    await run(
      `INSERT INTO daily_connections(day, device_hash, last_seen)
       VALUES(?, ?, ?)
       ON CONFLICT(day, device_hash) DO UPDATE SET last_seen=excluded.last_seen`,
      [day, req.deviceHash, nowIso()]
    );
  } catch (_) {}
  next();
});

// ======================
// Public API
// ======================
app.get("/api/public/stats", async (_req, res) => {
  const ideas = await get(`SELECT COUNT(*) AS n FROM ideas`);
  const votes = await get(`SELECT COUNT(*) AS n FROM poll_votes`);
  res.json({ ideas: ideas?.n ?? 0, votes: votes?.n ?? 0 });
});

app.get("/api/public/news", async (_req, res) => {
  const rows = await all(`SELECT id, title, description, created_at FROM news ORDER BY id DESC LIMIT 30`);
  res.json(rows);
});

app.post(
  "/api/public/ideas",
  body("text").isString().isLength({ min: 10, max: 500 }),
  body("category").isIn(["vie-scolaire", "cantine", "ecologie", "clubs-evenements", "materiel", "autre"]),
  body("urgency").isIn(["basse", "moyenne", "haute"]),
  body("hp").optional().isString().isLength({ max: 5 }), // honeypot must stay empty
  async (req, res) => {
    const errors = validationErrors(req);
    if (errors) return res.status(400).json({ error: errors });

    // honeypot (bots fill hidden fields)
    if ((req.body.hp || "").trim() !== "") return res.status(400).json({ error: "Requête invalide" });

    // cooldown per device
    const last = await get(
      `SELECT created_at FROM ideas WHERE device_hash = ? ORDER BY id DESC LIMIT 1`,
      [req.deviceHash]
    );
    if (last?.created_at) {
      const diff = (Date.now() - Date.parse(last.created_at)) / 1000;
      const remaining = Math.ceil(IDEA_COOLDOWN_SEC - diff);
      if (remaining > 0) {
        return res.status(429).json({ error: "Trop de requêtes", retry_after_sec: remaining });
      }
    }

    const text = cleanText(req.body.text, 500);
    const category = req.body.category;
    const urgency = req.body.urgency;

    await run(
      `INSERT INTO ideas(text, category, urgency, device_hash, created_at) VALUES(?, ?, ?, ?, ?)`,
      [text, category, urgency, req.deviceHash, nowIso()]
    );
    res.json({ ok: true });
  }
);

app.get("/api/public/poll", async (_req, res) => {
  const p = await get(`SELECT id, question, options_json, active, created_at FROM poll WHERE active = 1 ORDER BY id DESC LIMIT 1`);
  if (!p) return res.json({ active: 0 });

  const options = JSON.parse(p.options_json);
  const counts = await all(
    `SELECT option_index, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? GROUP BY option_index`,
    [p.id]
  );
  const total = counts.reduce((acc, r) => acc + r.n, 0);
  const map = new Map(counts.map(r => [r.option_index, r.n]));
  const results = options.map((label, idx) => {
    const votes = map.get(idx) || 0;
    const percent = total ? Math.round((votes / total) * 100) : 0;
    return { label, votes, percent };
  });

  res.json({
    id: p.id,
    question: p.question,
    options,
    active: !!p.active,
    created_at: p.created_at,
    results
  });
});

app.post(
  "/api/public/poll/:id/vote",
  body("optionIndex").isInt({ min: 0, max: 50 }),
  async (req, res) => {
    const errors = validationErrors(req);
    if (errors) return res.status(400).json({ error: errors });

    const pollId = Number(req.params.id);
    const p = await get(`SELECT id, options_json, active FROM poll WHERE id = ?`, [pollId]);
    if (!p || !p.active) return res.status(404).json({ error: "Sondage introuvable" });

    const options = JSON.parse(p.options_json);
    const idx = Number(req.body.optionIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) {
      return res.status(400).json({ error: "Option invalide" });
    }

    try {
      await run(
        `INSERT INTO poll_votes(poll_id, option_index, voter_hash, created_at) VALUES(?, ?, ?, ?)`,
        [pollId, idx, req.deviceHash, nowIso()]
      );
    } catch (e) {
      // UNIQUE violation -> already voted
      return res.status(409).json({ error: "Vote déjà enregistré" });
    }

    res.json({ ok: true });
  }
);

app.get("/api/public/info", async (_req, res) => {
  const rows = await all(`SELECT key, text, url FROM info_blocks`);
  const obj = {};
  for (const r of rows) obj[r.key] = { text: r.text, url: r.url };
  res.json({
    jpo: obj.jpo || null,
    mini_stages: obj.mini_stages || null,
    science_weekly: obj.science_weekly || null,
    cycle_mauriac: obj.cycle_mauriac || null,
    region_aides: obj.region_aides || null
  });
});


// ======================
// Push API
// ======================
app.get("/api/push/public-key", (_req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(501).json({ error: "Push non configuré (VAPID_PUBLIC_KEY)" });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post(
  "/api/push/subscribe",
  body("subscription").isObject(),
  body("subscription.endpoint").isString().isLength({ min: 10, max: 2000 }),
  body("subscription.keys").isObject(),
  body("subscription.keys.p256dh").isString().isLength({ min: 10, max: 300 }),
  body("subscription.keys.auth").isString().isLength({ min: 10, max: 300 }),
  async (req, res) => {
    const errors = validationErrors(req);
    if (errors) return res.status(400).json({ error: errors });

    const sub = req.body.subscription;
    const endpoint = String(sub.endpoint);
    const ua = cleanText(req.get("User-Agent") || "", 220);
    const now = nowIso();

    await run(
      `INSERT INTO push_subscriptions(endpoint, subscription_json, device_hash, user_agent, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         subscription_json=excluded.subscription_json,
         device_hash=excluded.device_hash,
         user_agent=excluded.user_agent,
         updated_at=excluded.updated_at`,
      [endpoint, JSON.stringify(sub), req.deviceHash, ua, now, now]
    );

    res.json({ ok: true });
  }
);

app.post(
  "/api/push/send",
  requireAdmin,
  body("title").isString().isLength({ min: 1, max: 60 }),
  body("body").isString().isLength({ min: 1, max: 180 }),
  body("url").optional({ nullable: true }).isString().isLength({ max: 300 }),
  body("tag").optional({ nullable: true }).isString().isLength({ max: 60 }),
  async (req, res) => {
    const errors = validationErrors(req);
    if (errors) return res.status(400).json({ error: errors });

    const payload = {
      title: cleanText(req.body.title, 60),
      body: cleanText(req.body.body, 180),
      url: req.body.url ? String(req.body.url).trim() : "/",
      tag: req.body.tag ? String(req.body.tag).trim() : "cvl",
      ts: nowIso()
    };

    const result = await sendPushToAll(payload);
    if (result.disabled) return res.status(501).json({ error: "Push non configuré (VAPID_*)" });

    res.json({ ok: true, ...result });
  }
);

// ======================
// Admin stats API
// ======================
app.get("/api/stats", requireAdmin, async (_req, res) => {
  const ideasTotal = await get(`SELECT COUNT(*) AS n FROM ideas`);
  const ideasByStatus = await all(`SELECT status, COUNT(*) AS n FROM ideas GROUP BY status ORDER BY n DESC`);
  const votesTotal = await get(`SELECT COUNT(*) AS n FROM poll_votes`);
  const newsTotal = await get(`SELECT COUNT(*) AS n FROM news`);

  const polls = await all(
    `SELECT p.id, p.question, p.active, p.created_at, COUNT(v.id) AS votes
     FROM poll p
     LEFT JOIN poll_votes v ON v.poll_id = p.id
     GROUP BY p.id
     ORDER BY p.id DESC
     LIMIT 10`
  );

  const last14 = await all(
    `SELECT day, COUNT(*) AS n
     FROM daily_connections
     WHERE day >= date('now', '-13 day')
     GROUP BY day
     ORDER BY day ASC`
  );

  res.json({
    ideas: { total: ideasTotal?.n ?? 0, byStatus: ideasByStatus.map(r => ({ status: r.status, count: r.n })) },
    votes: { total: votesTotal?.n ?? 0 },
    news: { total: newsTotal?.n ?? 0 },
    polls: polls.map(p => ({ id: p.id, question: p.question, active: !!p.active, created_at: p.created_at, votes: p.votes })),
    dailyConnections: last14.map(r => ({ day: r.day, count: r.n }))
  });
});

// ======================
// Auth
// ======================
app.post(
  "/api/auth/login",
  body("password").isString().isLength({ min: 6, max: 128 }),
  async (req, res) => {
    const errors = validationErrors(req);
    if (errors) return res.status(400).json({ error: errors });

    if (!ADMIN_PASSWORD_HASH) {
      return res.status(500).json({ error: "ADMIN_PASSWORD_HASH non configuré" });
    }

    const ok = await bcrypt.compare(String(req.body.password), ADMIN_PASSWORD_HASH);
    if (!ok) return res.status(401).json({ error: "Identifiants invalides" });

    const token = signAdminToken();
    setAuthCookie(res, token);
    res.json({ ok: true });
  }
);

app.post("/api/auth/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// ======================
// Admin API
// ======================
app.get("/api/admin/me", requireAdmin, (_req, res) => res.json({ admin: true }));

app.get("/api/admin/ideas", requireAdmin, async (_req, res) => {
  const rows = await all(
    `SELECT id, text, category, urgency, status, created_at FROM ideas ORDER BY id DESC LIMIT 500`
  );
  const map = {
    "vie-scolaire": "Vie scolaire",
    "cantine": "Cantine",
    "ecologie": "Écologie",
    "clubs-evenements": "Clubs & événements",
    "materiel": "Matériel",
    "autre": "Autre"
  };
  res.json(rows.map(r => ({ ...r, category_label: map[r.category] || r.category })));
});

app.post(
  "/api/admin/news",
  requireAdmin,
  body("title").isString().isLength({ min: 3, max: 80 }),
  body("description").isString().isLength({ min: 10, max: 800 }),
  async (req, res) => {
    const errors = validationErrors(req);
    if (errors) return res.status(400).json({ error: errors });

    const title = cleanText(req.body.title, 80);
    const description = cleanText(req.body.description, 800);
    await run(`INSERT INTO news(title, description, created_at) VALUES(?, ?, ?)`, [title, description, nowIso()]);

    // Auto-push (if configured)
    if (canUsePushConfig()) {
      await sendPushToAll({
        title: "📰 Nouvelle actualité",
        body: title,
        url: "/#actualites",
        tag: "news",
        ts: nowIso()
      });
    }

    res.json({ ok: true });
  }
);

app.post(
  "/api/admin/poll",
  requireAdmin,
  body("question").isString().isLength({ min: 5, max: 140 }),
  body("options").isArray({ min: 2, max: 8 }),
  body("options.*").isString().isLength({ min: 1, max: 60 }),
  async (req, res) => {
    const errors = validationErrors(req);
    if (errors) return res.status(400).json({ error: errors });

    const question = cleanText(req.body.question, 140);
    const options = req.body.options.map(o => cleanText(o, 60));

    // deactivate previous
    await run(`UPDATE poll SET active = 0 WHERE active = 1`);
    await run(
      `INSERT INTO poll(question, options_json, active, created_at) VALUES(?, ?, 1, ?)`,
      [question, JSON.stringify(options), nowIso()]
    );

    // Auto-push (if configured)
    if (canUsePushConfig()) {
      await sendPushToAll({
        title: "📊 Nouveau sondage",
        body: question,
        url: "/#sondage",
        tag: "poll",
        ts: nowIso()
      });
    }

    res.json({ ok: true });
  }
);

app.post(
  "/api/admin/info",
  requireAdmin,
  body("key").isIn(["jpo", "mini_stages", "science_weekly", "cycle_mauriac", "region_aides"]),
  body("text").isString().isLength({ min: 10, max: 1200 }),
  body("url").optional({ nullable: true }).isString().isLength({ max: 300 }),
  async (req, res) => {
    const errors = validationErrors(req);
    if (errors) return res.status(400).json({ error: errors });

    const key = req.body.key;
    const text = cleanText(req.body.text, 1200);
    const url = req.body.url ? String(req.body.url).trim() : null;

    await run(
      `INSERT INTO info_blocks(key, text, url) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET text=excluded.text, url=excluded.url`,
      [key, text, url]
    );
    res.json({ ok: true });
  }
);

// ======================
// Static PWA
// ======================
app.use(express.static(publicDir, {
  setHeaders: (res, filePath) => {
    // basic hardening: avoid sniffing
    res.setHeader("X-Content-Type-Options", "nosniff");
    // cache static assets except html
    if (!filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "public, max-age=86400");
    }
  }
}));

// Admin dashboard (static page)
app.get("/admin/dashboard", (_req, res) => res.sendFile(path.join(publicDir, "admin", "dashboard", "index.html")));
app.get("/admin/dashboard/", (_req, res) => res.sendFile(path.join(publicDir, "admin", "dashboard", "index.html")));

// SPA fallback
app.get("*", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

// Error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Erreur serveur" });
});

app.listen(PORT, () => {
  console.log(`CVL Secure running on http://localhost:${PORT}`);
});

// --------- helpers ---------
function validationErrors(req) {
  const r = validationResult(req);
  if (r.isEmpty()) return null;
  return r.array().map(e => `${e.path}: ${e.msg}`).join(", ");
}
