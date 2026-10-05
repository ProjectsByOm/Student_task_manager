require("dotenv").config();

const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const nodemailer = require('nodemailer');
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? "" : "daybook-local-secret");
const DB_PATH = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, "daybook.db"));
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS || 0);

if (!Number.isInteger(TRUST_PROXY_HOPS) || TRUST_PROXY_HOPS < 0) {
  throw new Error("TRUST_PROXY_HOPS must be a non-negative integer.");
}

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET must be set in production.");
}

if (process.env.NODE_ENV === "production" && !process.env.ADMIN_EMAIL) {
  throw new Error("ADMIN_EMAIL must be set in production.");
}
if (process.env.NODE_ENV === "production" && JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must contain at least 32 characters in production.");
}
if (process.env.NODE_ENV === "production") {
  let appUrl;
  try {
    appUrl = new URL(process.env.APP_URL);
  } catch (error) {
    throw new Error("APP_URL must be a valid public HTTPS URL in production.");
  }
  if (appUrl.protocol !== "https:") {
    throw new Error("APP_URL must use HTTPS in production.");
  }
}

const DEFAULT_COURSES = [
  { name: "Biology", color: "#719773" },
  { name: "Statistics", color: "#8599c0" },
  { name: "Literature", color: "#d38a6c" },
  { name: "History", color: "#c29b55" }
];

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new sqlite3.Database(DB_PATH);

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https://images.unsplash.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.disable("x-powered-by");
app.set("trust proxy", TRUST_PROXY_HOPS);

function resolveAllowedOrigins(req) {
  const host = req.get("host") || "";
  const protocol = req.protocol || "http";
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const origins = new Set();

  if (host) {
    origins.add(`${protocol}://${host}`);
  }
  if (forwardedHost) {
    origins.add(`${forwardedProto || protocol}://${forwardedHost}`);
  }

  try {
    if (process.env.APP_URL) {
      origins.add(new URL(process.env.APP_URL).origin);
    }
  } catch (error) {
    // Ignore invalid APP_URL values; production validation already enforces a valid URL.
  }

  return [...origins].filter(Boolean);
}

function requireSameOrigin(req, res, next) {
  const origin = req.get("origin");
  if (!origin) return next();
  try {
    const requestOrigin = new URL(origin).origin;
    const allowedOrigins = resolveAllowedOrigins(req);
    if (!allowedOrigins.includes(requestOrigin)) {
      return res.status(403).json({ error: "Cross-origin request blocked." });
    }
    return next();
  } catch (error) {
    return res.status(403).json({ error: "Invalid request origin." });
  }
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many authentication attempts. Please try again later." }
});
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many reset requests. Please try again later." }
});

function runSql(sql, params = []) {
  const operation = writeQueue.then(() => runSqlNow(sql, params));
  writeQueue = operation.catch(() => {});
  return operation;
}

let writeQueue = Promise.resolve();

function runSqlNow(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onDone(error) {
      if (error) {
        reject(error);
        return;
      }
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function withTransaction(callback) {
  const operation = writeQueue.then(async () => {
    await runSqlNow("BEGIN IMMEDIATE");
    try {
      const result = await callback(runSqlNow);
      await runSqlNow("COMMIT");
      return result;
    } catch (error) {
      await runSqlNow("ROLLBACK");
      throw error;
    }
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

function getRows(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows);
    });
  });
}

function getRow(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(row);
    });
  });
}

async function initializeDatabase() {
  await runSql("PRAGMA foreign_keys = ON");
  await runSql("PRAGMA journal_mode = WAL");
  await runSql("PRAGMA busy_timeout = 5000");
  await runSql(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      session_version INTEGER NOT NULL DEFAULT 0,
      theme TEXT DEFAULT 'light',
      accent TEXT DEFAULT '#2d5d50',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await runSql(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await runSql(`
    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await runSql(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      course TEXT NOT NULL,
      due TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'todo',
      completedAt TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  await runSql(`CREATE INDEX IF NOT EXISTS idx_courses_user ON courses(user_id);`);
  await runSql(`CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);`);

  const userColumns = await getRows("PRAGMA table_info(users)");
  if (!userColumns.some((column) => column.name === "role")) {
    await runSql("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }
  if (!userColumns.some((column) => column.name === "session_version")) {
    await runSql("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0");
  }

  const adminEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (adminEmail) {
    await runSql("UPDATE users SET role = 'admin' WHERE email = ?", [adminEmail]);
  }

  await runSql("CREATE INDEX IF NOT EXISTS idx_reset_tokens_user ON password_reset_tokens(user_id)");
  console.log("Database ready.");
}

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role || 'user',
    theme: user.theme || "light",
    accent: user.accent || "#2d5d50",
    createdAt: user.created_at
  };
}

function createToken(user) {
  return jwt.sign({ id: user.id, version: user.session_version || 0 }, JWT_SECRET, { expiresIn: "7d" });
}

async function requireAuth(req, res, next) {
  const tokenFromCookie = req.cookies && req.cookies.daybook_token;
  const authHeader = req.headers.authorization || "";
  const token = tokenFromCookie || (authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "");

  if (!token) {
    return res.status(401).json({ error: "Authentication required." });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await getRow("SELECT id, email, name, role, session_version FROM users WHERE id = ?", [payload.id]);
    if (!user || payload.version !== user.session_version) {
      return res.status(401).json({ error: "Session expired or invalid." });
    }
    req.user = user;
    return next();
  } catch (error) {
    if (error.name !== "JsonWebTokenError" && error.name !== "TokenExpiredError") {
      console.error("Authentication lookup failed:", error);
      return res.status(500).json({ error: "Could not verify session." });
    }
    return res.status(401).json({ error: "Session expired or invalid." });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin privileges required.' });
  }
  return next();
}

async function loadUserData(userId) {
  const [courses, tasks] = await Promise.all([
    getRows("SELECT id, name, color FROM courses WHERE user_id = ? ORDER BY created_at ASC", [userId]),
    getRows("SELECT id, title, course, due, priority, status, completedAt FROM tasks WHERE user_id = ? ORDER BY created_at ASC", [userId])
  ]);

  return {
    courses: courses.map((course) => ({
      id: course.id,
      name: course.name,
      color: course.color
    })),
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      course: task.course,
      due: task.due,
      priority: task.priority,
      status: task.status,
      completedAt: task.completedAt || null
    }))
  };
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizePlannerData(courses, tasks) {
  if (!Array.isArray(courses) || !Array.isArray(tasks) || courses.length > 100 || tasks.length > 5000) {
    throw Object.assign(new Error("Import must include up to 100 courses and 5,000 tasks."), { status: 400 });
  }

  const courseIds = new Map();
  const normalizedCourses = courses.map((course) => {
    if (!course || typeof course.name !== "string" || !course.name.trim() || course.name.trim().length > 40 ||
      typeof course.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(course.color)) {
      throw Object.assign(new Error("Each course must have a name up to 40 characters and a valid color."), { status: 400 });
    }
    const sourceId = String(course.id || "");
    if (sourceId && courseIds.has(sourceId)) {
      throw Object.assign(new Error("Course identifiers must be unique."), { status: 400 });
    }
    const id = crypto.randomUUID();
    if (sourceId) courseIds.set(sourceId, id);
    return { id, sourceId, name: course.name.trim(), color: course.color };
  });

  const normalizedTasks = tasks.map((task) => {
    if (!task || typeof task.title !== "string" || !task.title.trim() || task.title.trim().length > 120 ||
      !validDate(task.due) || !["high", "medium", "low"].includes(task.priority) ||
      !["todo", "doing", "done"].includes(task.status)) {
      throw Object.assign(new Error("Each task must have a title (up to 120 characters), valid due date, priority, and status."), { status: 400 });
    }
    const courseId = courseIds.get(String(task.course || ""));
    if (!courseId) {
      throw Object.assign(new Error("Every task must reference a course in the imported course list."), { status: 400 });
    }
    if (task.completedAt != null && !validDate(task.completedAt)) {
      throw Object.assign(new Error("Task completion dates must use YYYY-MM-DD format."), { status: 400 });
    }
    return {
      id: crypto.randomUUID(),
      title: task.title.trim(),
      course: courseId,
      due: task.due,
      priority: task.priority,
      status: task.status,
      completedAt: task.completedAt || null
    };
  });

  return {
    courses: normalizedCourses.map(({ id, name, color }) => ({ id, name, color })),
    tasks: normalizedTasks
  };
}

async function replaceUserData(userId, plannerData) {
  await withTransaction(async (write) => {
    await write("DELETE FROM tasks WHERE user_id = ?", [userId]);
    await write("DELETE FROM courses WHERE user_id = ?", [userId]);
    for (const course of plannerData.courses) {
      await write("INSERT INTO courses (id, user_id, name, color) VALUES (?, ?, ?, ?)",
        [course.id, userId, course.name, course.color]);
    }
    for (const task of plannerData.tasks) {
      await write("INSERT INTO tasks (id, user_id, title, course, due, priority, status, completedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [task.id, userId, task.title, task.course, task.due, task.priority, task.status, task.completedAt]);
    }
  });
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "daybook" });
});

app.post("/api/auth/signup", requireSameOrigin, authLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (typeof name !== "string" || typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "Name, email, and password are required." });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const trimmedName = String(name).trim();

    if (trimmedName.length < 2 || trimmedName.length > 80) {
      return res.status(400).json({ error: "Name must be between 2 and 80 characters." });
    }
    if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (String(password).length < 10 || String(password).length > 128) {
      return res.status(400).json({ error: "Password must be between 10 and 128 characters." });
    }

    const existing = await getRow("SELECT id FROM users WHERE email = ?", [normalizedEmail]);
    if (existing) {
      return res.status(409).json({ error: "An account with that email already exists." });
    }

    const adminEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    const assignedRole = normalizedEmail === adminEmail && adminEmail ? "admin" : "user";

    const userId = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(password, 12);
    await withTransaction(async (write) => {
      await write(
        "INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)",
        [userId, trimmedName, normalizedEmail, passwordHash, assignedRole]
      );
      for (const course of DEFAULT_COURSES) {
        await write(
          "INSERT INTO courses (id, user_id, name, color) VALUES (?, ?, ?, ?)",
          [crypto.randomUUID(), userId, course.name, course.color]
        );
      }
    });

    const user = await getRow("SELECT * FROM users WHERE id = ?", [userId]);
    const token = createToken(user);
    const userData = await loadUserData(userId);

    res.cookie("daybook_token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 7
    });

    return res.status(201).json({
      user: sanitizeUser(user),
      ...userData
    });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT") {
      return res.status(409).json({ error: "An account with that email already exists." });
    }
    console.error("Signup error:", error);
    return res.status(500).json({ error: "Could not create user account." });
  }
});

// Password reset: request a reset token (email sent when SMTP configured)
app.post("/api/auth/forgot", requireSameOrigin, resetLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== "string") return res.status(400).json({ error: "Email is required." });
    const normalizedEmail = String(email).trim().toLowerCase();
    if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    const smtpHost = process.env.SMTP_HOST;
    if (process.env.NODE_ENV === "production" && !smtpHost) {
      return res.status(503).json({ error: "Password reset email is not configured on this host." });
    }
    const user = await getRow('SELECT * FROM users WHERE email = ?', [normalizedEmail]);

    const token = crypto.randomBytes(32).toString("hex");
    const expires = Date.now() + 1000 * 60 * 60;
    if (user) {
      await withTransaction(async (write) => {
        await write("UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0", [user.id]);
        await write("INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)", [token, user.id, expires]);
      });
    }

    const appUrl = String(process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
    const resetLink = `${appUrl}/#reset=${token}`;

    if (smtpHost && user) {
      try {
        const transporter = nodemailer.createTransport({
          host: smtpHost,
          port: Number(process.env.SMTP_PORT || 587),
          secure: process.env.SMTP_SECURE === 'true',
          auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
        });
        await transporter.sendMail({
          from: process.env.SMTP_FROM || 'no-reply@daybook.local',
          to: user.email,
          subject: 'Daybook password reset',
          text: `Reset your password using this link: ${resetLink}`,
          html: `<p>Reset your password using this link: <a href="${resetLink}">${resetLink}</a></p>`
        });
        return res.json({ ok: true });
      } catch (emailErr) {
        console.error('Failed to send reset email:', emailErr);
        return res.json({ ok: true });
      }
    }

    if (process.env.NODE_ENV !== "production") {
      return res.json({ ok: true, resetLink });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ error: 'Could not process request.' });
  }
});

// Password reset endpoint: exchange token for new password
app.post("/api/auth/reset", requireSameOrigin, authLimiter, async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (typeof token !== "string" || typeof password !== "string") return res.status(400).json({ error: 'Token and new password are required.' });
    if (password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Password must be between 10 and 128 characters.' });

    const row = await getRow('SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0', [token]);
    if (!row) return res.status(400).json({ error: 'Invalid or used token.' });
    if (Number(row.expires_at) < Date.now()) return res.status(400).json({ error: 'Token expired.' });

    const user = await getRow('SELECT * FROM users WHERE id = ?', [row.user_id]);
    if (!user) return res.status(400).json({ error: 'User not found.' });

    const passwordHash = await bcrypt.hash(password, 12);
    await withTransaction(async (write) => {
      const currentToken = await getRow('SELECT token FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at >= ?', [token, Date.now()]);
      if (!currentToken) {
        throw Object.assign(new Error("Reset token has expired or already been used."), { status: 400 });
      }
      await write('UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?', [passwordHash, user.id]);
      await write('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?', [user.id]);
    });

    return res.json({ ok: true });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('Reset error:', err);
    return res.status(500).json({ error: 'Could not reset password.' });
  }
});

app.post("/api/auth/login", requireSameOrigin, authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normalizedEmail = String(email || "").trim().toLowerCase();

    if (!normalizedEmail || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const user = await getRow("SELECT * FROM users WHERE email = ?", [normalizedEmail]);
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const validPassword = await bcrypt.compare(String(password), user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = createToken(user);
    const userData = await loadUserData(user.id);

    res.cookie("daybook_token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 7
    });

    return res.json({
      user: sanitizeUser(user),
      ...userData
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "Could not sign in." });
  }
});

app.post("/api/auth/logout", requireSameOrigin, (req, res) => {
  res.clearCookie("daybook_token", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  return res.json({ ok: true });
});

app.put("/api/auth/profile", requireSameOrigin, requireAuth, async (req, res) => {
  try {
    const { theme, accent, name } = req.body || {};
    if (!["light", "forest", "sunset"].includes(theme) || typeof accent !== "string" || !/^#[0-9a-fA-F]{6}$/.test(accent)) {
      return res.status(400).json({ error: "Choose a valid theme and six-digit accent color." });
    }
    const safeTheme = theme;
    const safeAccent = accent;
    const safeName = String(name || "").trim();

    if (safeName.length > 0 && (safeName.length < 2 || safeName.length > 80)) {
      return res.status(400).json({ error: "Name must be between 2 and 80 characters." });
    }

    await runSql(
      "UPDATE users SET theme = ?, accent = ?, name = COALESCE(NULLIF(?, ''), name) WHERE id = ?",
      [safeTheme, safeAccent, safeName, req.user.id]
    );

    const user = await getRow("SELECT * FROM users WHERE id = ?", [req.user.id]);
    return res.json({ user: sanitizeUser(user) });
  } catch (error) {
    console.error("Profile update error:", error);
    return res.status(500).json({ error: "Could not update profile." });
  }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const user = await getRow("SELECT * FROM users WHERE id = ?", [req.user.id]);
    if (!user) {
      return res.status(401).json({ error: "User not found." });
    }

    const payload = await loadUserData(user.id);
    return res.json({ user: sanitizeUser(user), ...payload });
  } catch (error) {
    console.error("Auth me error:", error);
    return res.status(500).json({ error: "Failed to fetch profile." });
  }
});

app.get("/api/data", requireAuth, async (req, res) => {
  try {
    const user = await getRow("SELECT * FROM users WHERE id = ?", [req.user.id]);
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }

    const payload = await loadUserData(user.id);
    return res.json({ user: sanitizeUser(user), ...payload });
  } catch (error) {
    console.error("Load data error:", error);
    return res.status(500).json({ error: "Could not load user data." });
  }
});

app.put("/api/data", requireSameOrigin, requireAuth, async (req, res) => {
  try {
    const { courses, tasks } = req.body || {};
    const userId = req.user.id;
    const plannerData = normalizePlannerData(courses, tasks);
    await replaceUserData(userId, plannerData);

    const payload = await loadUserData(userId);
    const user = await getRow("SELECT * FROM users WHERE id = ?", [userId]);
    return res.json({ user: sanitizeUser(user), ...payload });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error("Save data error:", error);
    return res.status(500).json({ error: "Could not save planner data." });
  }
});

// Export user data as JSON
app.get('/api/data/export', requireAuth, async (req, res) => {
  try {
    const payload = await loadUserData(req.user.id);
    const user = await getRow('SELECT * FROM users WHERE id = ?', [req.user.id]);
    return res.json({ user: sanitizeUser(user), ...payload });
  } catch (err) {
    console.error('Export error:', err);
    return res.status(500).json({ error: 'Could not export data.' });
  }
});

// Import user data (replace when replace=true)
app.post("/api/data/import", requireSameOrigin, requireAuth, async (req, res) => {
  try {
    const { courses, tasks, replace } = req.body || {};
    if (typeof replace !== "boolean") {
      return res.status(400).json({ error: "Choose whether imported data should replace existing data." });
    }
    const plannerData = normalizePlannerData(courses, tasks);
    const userId = req.user.id;
    if (replace) {
      await replaceUserData(userId, plannerData);
    } else {
      await withTransaction(async (write) => {
        for (const course of plannerData.courses) {
          await write("INSERT INTO courses (id, user_id, name, color) VALUES (?, ?, ?, ?)",
            [course.id, userId, course.name, course.color]);
        }
        for (const task of plannerData.tasks) {
          await write("INSERT INTO tasks (id, user_id, title, course, due, priority, status, completedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [task.id, userId, task.title, task.course, task.due, task.priority, task.status, task.completedAt]);
        }
      });
    }

    const payload = await loadUserData(userId);
    const user = await getRow('SELECT * FROM users WHERE id = ?', [userId]);
    return res.json({ user: sanitizeUser(user), ...payload });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('Import error:', err);
    return res.status(500).json({ error: 'Could not import data.' });
  }
});

// Admin: list users
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = await getRows('SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC');
    const list = rows.map(r => ({ id: r.id, name: r.name, email: r.email, role: r.role, createdAt: r.created_at }));
    return res.json({ users: list });
  } catch (err) {
    console.error('Admin users error:', err);
    return res.status(500).json({ error: 'Could not load users.' });
  }
});

app.put("/api/admin/users/:id/role", requireSameOrigin, requireAuth, requireAdmin, async (req, res) => {
  try {
    const { role } = req.body || {};
    if (!["admin", "user"].includes(role)) {
      return res.status(400).json({ error: "Role must be admin or user." });
    }
    if (req.params.id === req.user.id && role !== "admin") {
      return res.status(400).json({ error: "You cannot remove your own admin access." });
    }

    await withTransaction(async (write) => {
      const target = await getRow("SELECT id, role FROM users WHERE id = ?", [req.params.id]);
      if (!target) throw Object.assign(new Error("User not found."), { status: 404 });

      if (target.role === "admin" && role !== "admin") {
        const admins = await getRow("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'");
        if (admins.count <= 1) {
          throw Object.assign(new Error("The last admin cannot be demoted."), { status: 400 });
        }
      }

      await write("UPDATE users SET role = ? WHERE id = ?", [role, req.params.id]);
    });
    return res.json({ ok: true });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error("Admin role update error:", error);
    return res.status(500).json({ error: "Could not update user role." });
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Request body must be valid JSON." });
  }
  if (error.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body is too large." });
  }
  console.error("Unhandled request error:", error);
  return res.status(500).json({ error: "An unexpected server error occurred." });
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/style.css", (req, res) => res.sendFile(path.join(__dirname, "style.css")));
app.get("/script.js", (req, res) => res.sendFile(path.join(__dirname, "script.js")));
app.use((req, res) => {
  return res.status(404).json({ error: "Not found." });
});

initializeDatabase().then(() => {
  const server = app.listen(PORT, () => {
    console.log(`Daybook API running at http://localhost:${PORT}`);
  });
  const shutdown = () => {
    server.close((serverError) => {
      db.close((databaseError) => {
        const error = serverError || databaseError;
        if (error) {
          console.error("Shutdown failed:", error);
          process.exitCode = 1;
        }
      });
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}).catch((error) => {
  console.error("Database initialization failed:", error);
  db.close(() => process.exit(1));
});
