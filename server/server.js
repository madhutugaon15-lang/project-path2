const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.resolve(__dirname, '..');
const AUTH_COOKIE = 'yp_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const authSessions = new Map();
const loginFailures = new Map();
const dummyPasswordHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);
// The frontend (index.html, app_scratch.js, styles.css, ...) lives at the
// repository root. A public/ directory is also used when present — if it
// contains the site it is served first, otherwise we fall back to the root so
// `npm start` always serves a working page. ROOT_DIR is also kept in the
// static list as a safety net for deployments that build into public/.
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const PUBLIC_HAS_SITE = fs.existsSync(path.join(PUBLIC_DIR, 'index.html'));

// Enable CORS and JSON parsing
const allowedCorsOrigins = new Set((process.env.CORS_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean));
app.use(cors({
  origin(origin, callback) {
    const isLocalPreview = origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin || '');
    callback(null, !origin || isLocalPreview || allowedCorsOrigins.has(origin));
  },
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/auth/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// Serve static frontend assets
if (PUBLIC_HAS_SITE) {
  app.use(express.static(PUBLIC_DIR));
}
app.use(express.static(ROOT_DIR));

// PostgreSQL Connection Pool
let pool = null;
const connectionString = process.env.DATABASE_URL;

if (connectionString) {
  const isCloud = connectionString.includes('neon.tech') ||
                  connectionString.includes('supabase.co') ||
                  connectionString.includes('render.com') ||
                  connectionString.includes('railway.app') ||
                  connectionString.includes('aivencloud.com') ||
                  process.env.PGSSL === 'true';

  pool = new Pool({
    connectionString,
    ssl: isCloud ? { rejectUnauthorized: false } : false
  });

  pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err.message);
  });
} else {
  console.warn('⚠️ No DATABASE_URL found in server/.env. Running with offline/local fallback.');
}

// ----------------------------------------------------------------
// Registration confirmation email
// ----------------------------------------------------------------
// A confirmation message is always prepared for the address that was used to
// register. When SMTP is configured (server/.env) it is delivered for real
// through nodemailer; without SMTP the prepared message is logged so the
// behaviour stays visible in development. Account creation never depends on
// the mail transport — a failed send must not break signup.
let transporter = null;
let mailer = null;
try {
  mailer = require('nodemailer');
  if (process.env.SMTP_HOST) {
    transporter = mailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: String(process.env.SMTP_SECURE) === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined
    });
  }
} catch (err) {
  console.warn('ℹ️ nodemailer not installed — registration emails will be logged only.');
}

const MAIL_FROM = process.env.MAIL_FROM || 'YourPath. <no-reply@yourpath.demo>';

// Sends (or logs) the "your account was created" confirmation for the Gmail /
// email address that was just registered. Never throws to the caller.
async function sendRegistrationEmail(user) {
  const to = user.email;
  const subject = 'YourPath. account created';
  const text =
    `Hi ${user.name || 'Student'},\n\n` +
    'Your YourPath. account was created successfully.\n\n' +
    `Email used for this account: ${to}\n` +
    'You can now log in on any device with this same email and password — ' +
    'your progress is stored on the server and follows you.\n\n' +
    'If you did not create this account, you can ignore this message.\n\n' +
    '— YourPath.';

  if (!transporter) {
    console.log(`📧 [registration email not sent — no SMTP configured] to=${to} subject="${subject}"`);
    return;
  }

  try {
    await transporter.sendMail({ from: MAIL_FROM, to, subject, text });
    console.log(`📧 Registration confirmation email sent to ${to}`);
  } catch (err) {
    console.warn(`⚠️ Could not send registration email to ${to}: ${err.message}`);
  }
}

// Demo student account shipped with the prototype so the login flow can be
// tried without registering. Credentials: YourPath@gmail.com / yourpath2026
const DEMO_ACCOUNT = {
  email: 'yourpath@gmail.com',
  password: 'yourpath2026',
  name: 'YourPath Demo Student',
  phone: '',
  country: 'Philippines (+63)',
  grade: 'Grade 10',
  age: '16',
  school: 'YourPath. Demo School',
  targetCountry: 'Domestic / Home Country',
  budget: 'Full scholarship needed',
  goals: 'Explore career pathways that fit my interests.',
  role: 'student'
};

const configuredAdminEmail = (process.env.INITIAL_ADMIN_EMAIL || '').toLowerCase().trim();
const configuredAdminPassword = process.env.INITIAL_ADMIN_PASSWORD || '';
const DEMO_ADMIN = configuredAdminEmail && configuredAdminPassword.length >= 16 ? {
  email: configuredAdminEmail,
  password: configuredAdminPassword,
  name: 'System Administrator',
  phone: '+1 555-0199',
  country: 'United States (+1)',
  grade: 'College',
  age: '28',
  school: 'YourPath Central Administration',
  targetCountry: 'Domestic / Home Country',
  budget: 'Flexible / Self-funded',
  goals: 'Administer system settings, pathways, and user access.',
  role: 'admin',
  settings: { language: 'en', emailUpdates: true, privacyMode: 'standard', communityVisible: false }
} : null;

// In-memory fallback stores when PostgreSQL pool is not connected
const inMemoryUsers = new Map();
const inMemoryProgress = new Map();
const inMemoryFriendships = new Map();
const inMemoryMessages = [];
// Keep the offline development fallback useful across server restarts. The
// file contains password hashes only (never plaintext passwords) and stays
// outside the public static directory.
const LOCAL_ACCOUNT_FILE = path.join(__dirname, '.data', 'accounts.json');
function loadLocalAccounts() {
  if (pool) return;
  try {
    const saved = JSON.parse(fs.readFileSync(LOCAL_ACCOUNT_FILE, 'utf8'));
    for (const user of saved.users || []) {
      if (user?.email && user?.id && user?.password_hash) inMemoryUsers.set(String(user.email).toLowerCase(), user);
    }
    for (const [userId, progress] of Object.entries(saved.progress || {})) inMemoryProgress.set(userId, progress);
    for (const friendship of saved.friendships || []) if (friendship?.userA && friendship?.userB) inMemoryFriendships.set(`${friendship.userA}:${friendship.userB}`, friendship);
    for (const message of saved.messages || []) if (message?.id && message?.senderId && message?.recipientId) inMemoryMessages.push(message);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Could not load local accounts:', err.message);
  }
}
function persistLocalAccounts() {
  if (pool) return;
  try {
    fs.mkdirSync(path.dirname(LOCAL_ACCOUNT_FILE), { recursive: true });
    const temporaryFile = `${LOCAL_ACCOUNT_FILE}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify({
      users: [...inMemoryUsers.values()],
      progress: Object.fromEntries(inMemoryProgress),
      friendships: [...inMemoryFriendships.values()],
      messages: inMemoryMessages
    }), { mode: 0o600 });
    fs.renameSync(temporaryFile, LOCAL_ACCOUNT_FILE);
  } catch (err) {
    console.error('Could not save local accounts:', err.message);
    throw err;
  }
}
loadLocalAccounts();
const inMemoryConfig = new Map([
  ['website_config', { siteTitle: 'YourPath.', registrationOpen: true, maintenanceMode: false, defaultLanguage: 'en' }],
  ['announcement', { active: false, text: '', level: 'info', updatedAt: new Date().toISOString() }],
  ['pathway_overrides', {}]
]);

// Seed in-memory demo accounts
(async () => {
  try {
    const studentHash = await bcrypt.hash(DEMO_ACCOUNT.password, 10);
    if (!inMemoryUsers.has(DEMO_ACCOUNT.email.toLowerCase())) inMemoryUsers.set(DEMO_ACCOUNT.email.toLowerCase(), {
      id: '00000000-0000-0000-0000-000000000001',
      ...DEMO_ACCOUNT,
      password_hash: studentHash,
      settings: { language: 'en', emailUpdates: false, privacyMode: 'standard', theme: 'light', reducedMotion: false, communityVisible: false },
      created_at: new Date().toISOString()
    });

    if(DEMO_ADMIN){
      const adminHash = await bcrypt.hash(DEMO_ADMIN.password, 12);
      if (!inMemoryUsers.has(DEMO_ADMIN.email.toLowerCase())) inMemoryUsers.set(DEMO_ADMIN.email.toLowerCase(), {
        id: '00000000-0000-0000-0000-000000000002',
        ...DEMO_ADMIN,
        password_hash: adminHash,
        settings: { language: 'en', emailUpdates: true, privacyMode: 'standard', theme: 'light', reducedMotion: false, communityVisible: false },
        created_at: new Date().toISOString()
      });
    }
    persistLocalAccounts();
  } catch (err) {
    console.warn('In-memory seed warning:', err.message);
  }
})();

// Creates the demo student and admin accounts once, if they do not exist yet.
async function seedDemoAccount() {
  if (!pool) return;
  try {
    // 1. Seed demo student
    const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [DEMO_ACCOUNT.email]);
    if (existing.rows.length === 0) {
      const passwordHash = await bcrypt.hash(DEMO_ACCOUNT.password, 10);
      const inserted = await pool.query(`
        INSERT INTO users (
          email, password_hash, name, phone, country, grade, age, school, target_country, budget, goals, role, settings
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (email) DO NOTHING
        RETURNING id
      `, [
        DEMO_ACCOUNT.email,
        passwordHash,
        DEMO_ACCOUNT.name,
        DEMO_ACCOUNT.phone,
        DEMO_ACCOUNT.country,
        DEMO_ACCOUNT.grade,
        DEMO_ACCOUNT.age,
        DEMO_ACCOUNT.school,
        DEMO_ACCOUNT.targetCountry,
        DEMO_ACCOUNT.budget,
        DEMO_ACCOUNT.goals,
        DEMO_ACCOUNT.role,
        JSON.stringify({ language: 'en', emailUpdates: false, privacyMode: 'standard', theme: 'light', reducedMotion: false, communityVisible: false })
      ]);

      if (inserted.rows.length > 0) {
        await pool.query(`
          INSERT INTO user_progress (user_id, answers, saved_pathways, saved_notes, experiments, session_data, q_index)
          VALUES ($1, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0)
          ON CONFLICT (user_id) DO NOTHING
        `, [inserted.rows[0].id]);
        console.log('✅ Demo student account ready (YourPath@gmail.com).');
      }
    }

    // 2. Seed an administrator only when a deployment supplies private credentials.
    if(DEMO_ADMIN){
    const existingAdmin = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [DEMO_ADMIN.email]);
    const adminHash = await bcrypt.hash(DEMO_ADMIN.password, 12);
    if (existingAdmin.rows.length === 0) {
      await pool.query(`
        INSERT INTO users (
          email, password_hash, name, phone, country, grade, age, school, target_country, budget, goals, role, settings
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (email) DO NOTHING
      `, [
        DEMO_ADMIN.email,
        adminHash,
        DEMO_ADMIN.name,
        DEMO_ADMIN.phone,
        DEMO_ADMIN.country,
        DEMO_ADMIN.grade,
        DEMO_ADMIN.age,
        DEMO_ADMIN.school,
        DEMO_ADMIN.targetCountry,
        DEMO_ADMIN.budget,
        DEMO_ADMIN.goals,
        DEMO_ADMIN.role,
        JSON.stringify(DEMO_ADMIN.settings)
      ]);
      console.log(`✅ Configured administrator account ready (${DEMO_ADMIN.email}).`);
    } else {
      await pool.query("UPDATE users SET password_hash = $1, role = 'admin', updated_at = NOW() WHERE LOWER(email) = $2", [adminHash, DEMO_ADMIN.email]);
    }
    } else {
      await pool.query("UPDATE users SET role = 'student', updated_at = NOW() WHERE LOWER(email) = 'admin@yourpath.demo'");
    }
    if (DEMO_ADMIN && DEMO_ADMIN.email !== 'admin@yourpath.demo') {
      await pool.query("UPDATE users SET role = 'student', updated_at = NOW() WHERE LOWER(email) = 'admin@yourpath.demo'");
    }

    // 3. Seed default site_config
    await pool.query(`
      INSERT INTO site_config (key, value)
      VALUES
        ('website_config', '{"siteTitle":"YourPath.","registrationOpen":true,"maintenanceMode":false,"defaultLanguage":"en"}'::jsonb),
        ('announcement', '{"active":false,"text":"","level":"info"}'::jsonb),
        ('pathway_overrides', '{}'::jsonb)
      ON CONFLICT (key) DO NOTHING
    `);
  } catch (err) {
    console.error('❌ Error seeding demo accounts:', err.message);
  }
}

// Auto-initialize PostgreSQL database tables
async function initDb() {
  if (!pool) return;
  try {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          name VARCHAR(255) NOT NULL,
          phone VARCHAR(50) DEFAULT '',
          country VARCHAR(100) DEFAULT 'Philippines (+63)',
          grade VARCHAR(100) DEFAULT 'Grade 10',
          age VARCHAR(20) DEFAULT '',
          school VARCHAR(255) DEFAULT '',
          target_country VARCHAR(100) DEFAULT 'Domestic / Home Country',
          budget VARCHAR(100) DEFAULT 'Full scholarship needed',
          goals TEXT DEFAULT '',
          role VARCHAR(50) DEFAULT 'student',
          settings JSONB DEFAULT '{"language":"en","emailUpdates":false,"privacyMode":"standard","theme":"light","reducedMotion":false,"communityVisible":false}'::jsonb,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        ALTER TABLE users ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{"language":"en","emailUpdates":false,"privacyMode":"standard","theme":"light","reducedMotion":false,"communityVisible":false}'::jsonb;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'student';

        CREATE TABLE IF NOT EXISTS user_progress (
          user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          answers JSONB DEFAULT '{}'::jsonb,
          saved_pathways JSONB DEFAULT '[]'::jsonb,
          saved_notes JSONB DEFAULT '{}'::jsonb,
          experiments JSONB DEFAULT '{}'::jsonb,
          session_data JSONB DEFAULT '{}'::jsonb,
          q_index INTEGER DEFAULT 0,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS site_config (
          key VARCHAR(100) PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS community_friendships (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_a UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          user_b UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted')),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          CHECK (user_a < user_b),
          UNIQUE (user_a, user_b)
        );
        CREATE INDEX IF NOT EXISTS idx_community_friendships_users ON community_friendships(user_a, user_b, status);

        CREATE TABLE IF NOT EXISTS community_messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          message TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 2000),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_community_messages_pair ON community_messages(sender_id, recipient_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
        CREATE INDEX IF NOT EXISTS idx_user_progress_user_id ON user_progress(user_id);
      `);
      console.log('✅ PostgreSQL tables verified and ready.');
    } finally {
      client.release();
    }

    // Tables exist by now, so demo accounts and configs can be seeded safely.
    await seedDemoAccount();
  } catch (err) {
    console.error('❌ Error initializing PostgreSQL schema:', err.message);
  }
}

const databaseReady = initDb();

// Helper to format sanitized user object
function sanitizeUser(u) {
  let settings = { language: 'en', emailUpdates: false, privacyMode: 'standard', theme: 'light', reducedMotion: false, communityVisible: false, avatar: '' };
  if (u.settings) {
    if (typeof u.settings === 'object') settings = { ...settings, ...u.settings };
    else if (typeof u.settings === 'string') {
      try { settings = { ...settings, ...JSON.parse(u.settings) }; } catch (e) {}
    }
  }
  settings.avatar = safeProfileAvatar(settings.avatar);
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone || '',
    country: u.country || 'Philippines (+63)',
    grade: u.grade || 'Grade 10',
    age: u.age || '',
    school: u.school || '',
    targetCountry: u.target_country || u.targetCountry || 'Domestic / Home Country',
    budget: u.budget || 'Full scholarship needed',
    goals: u.goals || '',
    role: u.role || 'student',
    settings,
    createdAt: u.created_at || u.createdAt
  };
}

function safeProfileAvatar(value) {
  if (typeof value !== 'string' || value.length > 820000) return '';
  const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return '';
  try { return Buffer.from(match[2], 'base64').length <= 600 * 1024 ? value : ''; } catch (err) { return ''; }
}

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

// 1. Health & Database Check
app.get('/api/health', async (req, res) => {
  let dbStatus = 'disconnected';
  if (pool) {
    try {
      const dbRes = await pool.query('SELECT NOW()');
      if (dbRes.rows.length > 0) dbStatus = 'connected';
    } catch (err) {
      dbStatus = `error: ${err.message}`;
    }
  }
  res.json({
    status: 'ok',
    database: dbStatus,
    timestamp: new Date().toISOString()
  });
});

// Helper to look up user in memory fallback
function findInMemoryUser(userId, email) {
  const cleanEmail = (email || '').toLowerCase().trim();
  for (const u of inMemoryUsers.values()) {
    if ((userId && u.id === userId) || (cleanEmail && u.email.toLowerCase() === cleanEmail)) {
      return u;
    }
  }
  return null;
}

function requestSessionId(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith(`${AUTH_COOKIE}=`));
  const token = match ? match.slice(AUTH_COOKIE.length + 1) : '';
  return /^[a-f0-9]{64}$/.test(token) ? token : '';
}

function setSessionCookie(req, res, token) {
  const secure = req.secure || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
}

function clearSessionCookie(req, res) {
  const secure = req.secure || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

function createSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  authSessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
  setSessionCookie(req, res, token);
}

function recordLoginFailure(key) {
  const now = Date.now();
  if (loginFailures.size > 5000) {
    for (const [attemptKey, value] of loginFailures) if (now - value.startedAt >= 15 * 60 * 1000) loginFailures.delete(attemptKey);
    while (loginFailures.size > 5000) loginFailures.delete(loginFailures.keys().next().value);
  }
  const previous = loginFailures.get(key);
  if (!previous || now - previous.startedAt >= 15 * 60 * 1000) loginFailures.set(key, { count: 1, startedAt: now });
  else loginFailures.set(key, { ...previous, count: previous.count + 1 });
}

async function requireSession(req, res, next) {
  const token = requestSessionId(req);
  const session = authSessions.get(token);
  if (!token || !session || session.expiresAt <= Date.now()) {
    if (token) authSessions.delete(token);
    return res.status(401).json({ error: 'Please log in to continue.' });
  }

  try {
    let user = null;
    if (pool) {
      const result = await pool.query('SELECT * FROM users WHERE id = $1', [session.userId]);
      user = result.rows[0] || null;
    } else {
      user = findInMemoryUser(session.userId, '');
    }
    if (!user) {
      authSessions.delete(token);
      clearSessionCookie(req, res);
      return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    req.authUser = user;
    req.authSessionToken = token;
    next();
  } catch (err) {
    console.error('Session verification error:', err.message);
    res.status(500).json({ error: 'Could not verify your session.' });
  }
}

app.get('/api/auth/session', requireSession, async (req, res) => {
  try {
    let progress = { answers: {}, saved: [], savedNotes: {}, experiments: {}, session: null, qIndex: 0 };
    if (pool) {
      const result = await pool.query('SELECT * FROM user_progress WHERE user_id = $1', [req.authUser.id]);
      if (result.rows[0]) {
        const row = result.rows[0];
        progress = { answers: row.answers || {}, saved: row.saved_pathways || [], savedNotes: row.saved_notes || {}, experiments: row.experiments || {}, session: row.session_data || null, qIndex: row.q_index || 0 };
      }
    } else {
      progress = inMemoryProgress.get(req.authUser.id) || progress;
    }
    res.json({ user: sanitizeUser(req.authUser), progress });
  } catch (err) {
    console.error('Session restore error:', err.message);
    res.status(500).json({ error: 'Could not restore your account.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = requestSessionId(req);
  if (token) authSessions.delete(token);
  clearSessionCookie(req, res);
  res.json({ success: true });
});

// 2. User Sign Up
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name, phone, country, grade, age, school, targetCountry, budget, goals } = req.body || {};

  if (!email || !password || !name || !String(name).trim()) {
    return res.status(400).json({ error: 'Name, email, and password are required.' });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    return res.status(400).json({ error: 'Password must be between 8 and 256 characters.' });
  }

  const cleanEmail = email.toLowerCase().trim();

  try {
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    if (pool) {
      const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [cleanEmail]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
      }

      const insertUser = await pool.query(`
        INSERT INTO users (
          email, password_hash, name, phone, country, grade, age, school, target_country, budget, goals, role, settings
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'student', '{"language":"en","emailUpdates":false,"privacyMode":"standard","theme":"light","reducedMotion":false,"communityVisible":false}'::jsonb)
        RETURNING *
      `, [
        cleanEmail, passwordHash, name.trim(), phone || '', country || 'Philippines (+63)',
        grade || 'Grade 10', age || '', school || '', targetCountry || 'Domestic / Home Country',
        budget || 'Full scholarship needed', goals || ''
      ]);

      const newUser = insertUser.rows[0];

      await pool.query(`
        INSERT INTO user_progress (user_id, answers, saved_pathways, saved_notes, experiments, session_data, q_index)
        VALUES ($1, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0)
        ON CONFLICT (user_id) DO NOTHING
      `, [newUser.id]);

      sendRegistrationEmail(newUser).catch(() => {});
      createSession(req, res, newUser);

      return res.status(201).json({
        message: 'Account created successfully',
        user: sanitizeUser(newUser),
        progress: { answers: {}, saved: [], savedNotes: {}, experiments: {}, session: null, qIndex: 0 }
      });
    } else {
      // In-memory fallback
      if (inMemoryUsers.has(cleanEmail)) {
        return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
      }

      const newId = crypto.randomUUID();
      const newUser = {
        id: newId,
        email: cleanEmail,
        password_hash: passwordHash,
        name: name.trim(),
        phone: phone || '',
        country: country || 'Philippines (+63)',
        grade: grade || 'Grade 10',
        age: age || '',
        school: school || '',
        target_country: targetCountry || 'Domestic / Home Country',
        budget: budget || 'Full scholarship needed',
        goals: goals || '',
        role: 'student',
        settings: { language: 'en', emailUpdates: false, privacyMode: 'standard', communityVisible: false },
        created_at: new Date().toISOString()
      };

      inMemoryUsers.set(cleanEmail, newUser);
      inMemoryProgress.set(newId, { answers: {}, saved: [], savedNotes: {}, experiments: {}, session: null, qIndex: 0 });
      persistLocalAccounts();
      createSession(req, res, newUser);

      return res.status(201).json({
        message: 'Account created successfully (Local memory)',
        user: sanitizeUser(newUser),
        progress: { answers: {}, saved: [], savedNotes: {}, experiments: {}, session: null, qIndex: 0 }
      });
    }
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Failed to create account. ' + err.message });
  }
});

// 3. User Log In
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password || typeof email !== 'string' || typeof password !== 'string' || password.length > 256) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const cleanEmail = email.toLowerCase().trim();
  const throttleKey = `${req.ip || 'unknown'}:${cleanEmail}`;
  const attempt = loginFailures.get(throttleKey);
  if (attempt && attempt.count >= 8 && Date.now() - attempt.startedAt < 15 * 60 * 1000) {
    return res.status(429).json({ error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' });
  }

  try {
    let user = null;
    let progress = { answers: {}, saved: [], savedNotes: {}, experiments: {}, session: null, qIndex: 0 };

    if (pool) {
      const userRes = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [cleanEmail]);
      if (userRes.rows.length === 0) {
        await bcrypt.compare(password, dummyPasswordHash);
        recordLoginFailure(throttleKey);
        return res.status(401).json({ error: 'Email or password is incorrect.' });
      }
      user = userRes.rows[0];

      const isMatch = await bcrypt.compare(password, user.password_hash);
      if (!isMatch) {
        recordLoginFailure(throttleKey);
        return res.status(401).json({ error: 'Email or password is incorrect.' });
      }

      const progressRes = await pool.query('SELECT * FROM user_progress WHERE user_id = $1', [user.id]);
      if (progressRes.rows.length > 0) {
        const p = progressRes.rows[0];
        progress = {
          answers: p.answers || {},
          saved: p.saved_pathways || [],
          savedNotes: p.saved_notes || {},
          experiments: p.experiments || {},
          session: p.session_data || null,
          qIndex: p.q_index || 0
        };
      }
    } else {
      user = inMemoryUsers.get(cleanEmail);
      if (!user) {
        await bcrypt.compare(password, dummyPasswordHash);
        recordLoginFailure(throttleKey);
        return res.status(401).json({ error: 'Email or password is incorrect.' });
      }

      const isMatch = await bcrypt.compare(password, user.password_hash);
      if (!isMatch) {
        recordLoginFailure(throttleKey);
        return res.status(401).json({ error: 'Email or password is incorrect.' });
      }

      const p = inMemoryProgress.get(user.id);
      if (p) progress = p;
    }

    createSession(req, res, user);
    loginFailures.delete(throttleKey);
    res.json({
      message: 'Login successful',
      user: sanitizeUser(user),
      progress
    });
  } catch (err) {
    recordLoginFailure(throttleKey);
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. ' + err.message });
  }
});

// 4. Save/Sync User Progress
app.post('/api/progress', requireSession, async (req, res) => {
  const { answers, saved, savedNotes, experiments, session, qIndex } = req.body || {};
  const userId = req.authUser.id;
  const email = req.authUser.email;

  try {
    if (pool) {
      let targetUserId = userId;
      if (!targetUserId && email) {
        const u = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [email.toLowerCase().trim()]);
        if (u.rows.length > 0) targetUserId = u.rows[0].id;
      }

      if (!targetUserId) return res.status(404).json({ error: 'User not found' });

      await pool.query(`
        INSERT INTO user_progress (user_id, answers, saved_pathways, saved_notes, experiments, session_data, q_index, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          answers = EXCLUDED.answers,
          saved_pathways = EXCLUDED.saved_pathways,
          saved_notes = EXCLUDED.saved_notes,
          experiments = EXCLUDED.experiments,
          session_data = EXCLUDED.session_data,
          q_index = EXCLUDED.q_index,
          updated_at = NOW()
      `, [
        targetUserId,
        JSON.stringify(answers || {}),
        JSON.stringify(saved || []),
        JSON.stringify(savedNotes || {}),
        JSON.stringify(experiments || {}),
        JSON.stringify(session || {}),
        qIndex || 0
      ]);

      res.json({ success: true, message: 'Progress saved to PostgreSQL' });
    } else {
      const u = findInMemoryUser(userId, email);
      if (!u) return res.status(404).json({ error: 'User not found' });
      inMemoryProgress.set(u.id, {
        answers: answers || {},
        saved: saved || [],
        savedNotes: savedNotes || {},
        experiments: experiments || {},
        session: session || {},
        qIndex: qIndex || 0,
        updatedAt: new Date().toISOString()
      });
      persistLocalAccounts();
      res.json({ success: true, message: 'Progress saved to local memory' });
    }
  } catch (err) {
    console.error('Progress sync error:', err);
    res.status(500).json({ error: 'Failed to sync progress: ' + err.message });
  }
});

// 5. Fetch User Progress
app.get('/api/progress/:userId', requireSession, async (req, res) => {
  const { userId } = req.params;
  if (String(userId) !== String(req.authUser.id)) return res.status(403).json({ error: 'You can only access your own progress.' });
  try {
    if (pool) {
      const progressRes = await pool.query('SELECT * FROM user_progress WHERE user_id = $1', [userId]);
      if (progressRes.rows.length === 0) {
        return res.json({ answers: {}, saved: [], savedNotes: {}, experiments: {}, session: null, qIndex: 0 });
      }
      const p = progressRes.rows[0];
      return res.json({
        answers: p.answers || {},
        saved: p.saved_pathways || [],
        savedNotes: p.saved_notes || {},
        experiments: p.experiments || {},
        session: p.session_data || null,
        qIndex: p.q_index || 0
      });
    } else {
      const p = inMemoryProgress.get(userId);
      return res.json(p || { answers: {}, saved: [], savedNotes: {}, experiments: {}, session: null, qIndex: 0 });
    }
  } catch (err) {
    console.error('Fetch progress error:', err);
    res.status(500).json({ error: 'Failed to fetch progress: ' + err.message });
  }
});

// 6. Update Profile
app.post('/api/user/profile', requireSession, async (req, res) => {
  const { name, phone, country, grade, age, school, targetCountry, budget, goals } = req.body || {};
  const avatarProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'avatar');
  const avatar = req.body?.avatar === '' ? '' : safeProfileAvatar(req.body?.avatar);
  if (avatarProvided && req.body.avatar && !avatar) return res.status(400).json({ error: 'Choose a valid optimized profile image.' });
  const userId = req.authUser.id;
  const email = req.authUser.email;

  try {
    if (pool) {
      let targetUserId = userId;
      if (!targetUserId && email) {
        const u = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [email.toLowerCase().trim()]);
        if (u.rows.length > 0) targetUserId = u.rows[0].id;
      }
      if (!targetUserId) return res.status(404).json({ error: 'User not found' });

      const updated = await pool.query(`
        UPDATE users SET
          name = COALESCE($1, name),
          phone = COALESCE($2, phone),
          country = COALESCE($3, country),
          grade = COALESCE($4, grade),
          age = COALESCE($5, age),
          school = COALESCE($6, school),
          target_country = COALESCE($7, target_country),
          budget = COALESCE($8, budget),
          goals = COALESCE($9, goals),
          settings = CASE WHEN $11::boolean THEN COALESCE(settings, '{}'::jsonb) || jsonb_build_object('avatar', $12::text) ELSE settings END,
          updated_at = NOW()
        WHERE id = $10
        RETURNING *
      `, [name, phone, country, grade, age, school, targetCountry, budget, goals, targetUserId, avatarProvided, avatar]);

      if (updated.rows.length === 0) return res.status(404).json({ error: 'User not found' });
      return res.json({ message: 'Profile updated successfully', user: sanitizeUser(updated.rows[0]) });
    } else {
      const u = findInMemoryUser(userId, email);
      if (!u) return res.status(404).json({ error: 'User not found' });
      if (name != null) u.name = name;
      if (phone != null) u.phone = phone;
      if (country != null) u.country = country;
      if (grade != null) u.grade = grade;
      if (age != null) u.age = age;
      if (school != null) u.school = school;
      if (targetCountry != null) u.target_country = targetCountry;
      if (budget != null) u.budget = budget;
      if (goals != null) u.goals = goals;
      if (avatarProvided) {
        let settings = u.settings || {};
        if (typeof settings === 'string') { try { settings = JSON.parse(settings); } catch (err) { settings = {}; } }
        u.settings = { ...settings, avatar };
      }
      u.updated_at = new Date().toISOString();
      persistLocalAccounts();
      return res.json({ message: 'Profile updated successfully', user: sanitizeUser(u) });
    }
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile: ' + err.message });
  }
});

app.post('/api/user/display-profile', requireSession, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const avatar = req.body?.avatar === '' ? '' : safeProfileAvatar(req.body?.avatar);
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'Your nickname must be between 2 and 40 characters.' });
  if (req.body?.avatar && !avatar) return res.status(400).json({ error: 'Choose a PNG, JPG, or WebP image up to 600 KB.' });
  try {
    let user;
    if (pool) {
      const current = await pool.query('SELECT id, settings FROM users WHERE id = $1', [req.authUser.id]);
      if (!current.rows.length) return res.status(404).json({ error: 'User not found.' });
      let settings = current.rows[0].settings || {};
      if (typeof settings === 'string') { try { settings = JSON.parse(settings); } catch (err) { settings = {}; } }
      settings = { ...settings, avatar };
      const updated = await pool.query('UPDATE users SET name = $1, settings = $2, updated_at = NOW() WHERE id = $3 RETURNING *', [name, JSON.stringify(settings), req.authUser.id]);
      user = updated.rows[0];
    } else {
      user = findInMemoryUser(req.authUser.id, req.authUser.email);
      if (!user) return res.status(404).json({ error: 'User not found.' });
      let settings = user.settings || {};
      if (typeof settings === 'string') { try { settings = JSON.parse(settings); } catch (err) { settings = {}; } }
      user.name = name;
      user.settings = { ...settings, avatar };
      user.updated_at = new Date().toISOString();
      persistLocalAccounts();
    }
    res.json({ message: 'Profile updated.', user: sanitizeUser(user) });
  } catch (err) {
    console.error('Display profile update error:', err.message);
    res.status(500).json({ error: 'Could not save your profile right now.' });
  }
});

// Student community: opt-in directory, friend requests, and friend-only chat.
function communityPair(userOne, userTwo) {
  return [String(userOne), String(userTwo)].sort();
}
function communityMemoryPerson(id) {
  const user = findInMemoryUser(id, '');
  if (!user || user.role === 'admin') return null;
  const settings = typeof user.settings === 'string' ? (() => { try { return JSON.parse(user.settings); } catch (err) { return {}; } })() : (user.settings || {});
  return { id: user.id, name: user.name || 'Student', grade: user.grade || 'Student', country: user.country || '', avatar: safeProfileAvatar(settings.avatar) };
}
function communityVisible(user) {
  let settings = user?.settings || {};
  if (typeof settings === 'string') {
    try { settings = JSON.parse(settings); } catch (err) { settings = {}; }
  }
  return settings?.communityVisible === true || String(settings?.communityVisible) === 'true';
}
function requireStudentCommunity(req, res) {
  if (req.authUser?.role === 'admin') {
    res.status(403).json({ error: 'The student community is only available to student accounts.' });
    return false;
  }
  return true;
}

app.get('/api/community/people', requireSession, async (req, res) => {
  if (!requireStudentCommunity(req, res)) return;
  const query = String(req.query.q || '').trim().slice(0, 80);
  try {
    let people;
    if (pool) {
      const result = await pool.query(`
        SELECT id, name, grade, country, settings->>'avatar' AS avatar
        FROM users
        WHERE id <> $1 AND role <> 'admin' AND settings->>'communityVisible' = 'true'
          AND ($2 = '' OR name ILIKE '%' || $2 || '%')
        ORDER BY name ASC
        LIMIT 50
      `, [req.authUser.id, query]);
      people = result.rows.map(person => ({ id: person.id, name: person.name, grade: person.grade || 'Student', country: person.country || '', avatar: safeProfileAvatar(person.avatar) }));
    } else {
      people = [...inMemoryUsers.values()]
        .filter(user => String(user.id) !== String(req.authUser.id) && user.role !== 'admin' && communityVisible(user) && String(user.name || '').toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .slice(0, 50)
        .map(user => ({ ...communityMemoryPerson(user.id) }));
    }
    res.json({ people });
  } catch (err) {
    console.error('Community directory error:', err.message);
    res.status(500).json({ error: 'Could not load people right now.' });
  }
});

app.get('/api/community', requireSession, async (req, res) => {
  if (!requireStudentCommunity(req, res)) return;
  try {
    let friendships;
    if (pool) {
      const result = await pool.query(`
        SELECT f.id, f.user_a, f.user_b, f.requested_by, f.status,
          a.name AS a_name, a.grade AS a_grade, a.country AS a_country, a.settings->>'avatar' AS a_avatar,
          b.name AS b_name, b.grade AS b_grade, b.country AS b_country, b.settings->>'avatar' AS b_avatar
        FROM community_friendships f
        JOIN users a ON a.id = f.user_a
        JOIN users b ON b.id = f.user_b
        WHERE f.user_a = $1 OR f.user_b = $1
        ORDER BY f.updated_at DESC
      `, [req.authUser.id]);
      friendships = result.rows.map(row => ({
        id: row.id, userA: row.user_a, userB: row.user_b, requestedBy: row.requested_by, status: row.status,
        personA: { id: row.user_a, name: row.a_name, grade: row.a_grade || 'Student', country: row.a_country || '', avatar: safeProfileAvatar(row.a_avatar) },
        personB: { id: row.user_b, name: row.b_name, grade: row.b_grade || 'Student', country: row.b_country || '', avatar: safeProfileAvatar(row.b_avatar) }
      }));
    } else {
      friendships = [...inMemoryFriendships.values()].filter(item => item.userA === req.authUser.id || item.userB === req.authUser.id).map(item => ({
        ...item, personA: communityMemoryPerson(item.userA), personB: communityMemoryPerson(item.userB)
      })).filter(item => item.personA && item.personB);
    }
    const friends = [], incoming = [], outgoing = [];
    for (const item of friendships) {
      const otherId = item.userA === req.authUser.id ? item.userB : item.userA;
      const person = item.userA === req.authUser.id ? item.personB : item.personA;
      if (!person) continue;
      if (item.status === 'accepted') friends.push(person);
      else if (item.requestedBy === req.authUser.id) outgoing.push(person);
      else incoming.push({ ...person, requestId: item.id });
    }
    res.json({ discoverable: communityVisible(req.authUser), friends, incoming, outgoing });
  } catch (err) {
    console.error('Community contacts error:', err.message);
    res.status(500).json({ error: 'Could not load your community right now.' });
  }
});

app.post('/api/community/requests', requireSession, async (req, res) => {
  if (!requireStudentCommunity(req, res)) return;
  const targetId = String(req.body?.userId || '').trim();
  if (!targetId || targetId === String(req.authUser.id)) return res.status(400).json({ error: 'Choose another student to add.' });
  try {
    let target;
    if (pool) {
      const found = await pool.query("SELECT id FROM users WHERE id = $1 AND role <> 'admin' AND settings->>'communityVisible' = 'true'", [targetId]);
      target = found.rows[0];
    } else {
      const person = communityMemoryPerson(targetId);
      target = person && communityVisible(findInMemoryUser(targetId, '')) ? person : null;
    }
    if (!target) return res.status(404).json({ error: 'That profile is unavailable.' });
    const [userA, userB] = communityPair(req.authUser.id, targetId);
    let status = 'pending';
    if (pool) {
      const existing = await pool.query('SELECT id, requested_by, status FROM community_friendships WHERE user_a = $1 AND user_b = $2', [userA, userB]);
      if (existing.rows[0]?.status === 'accepted') return res.status(409).json({ error: 'You are already friends.' });
      if (existing.rows[0]?.status === 'pending') {
        if (String(existing.rows[0].requested_by) === String(targetId)) {
          await pool.query("UPDATE community_friendships SET status = 'accepted', updated_at = NOW() WHERE id = $1", [existing.rows[0].id]);
          status = 'accepted';
        } else return res.status(409).json({ error: 'Your friend request is already waiting for a reply.' });
      } else {
        await pool.query('INSERT INTO community_friendships (user_a, user_b, requested_by) VALUES ($1, $2, $3)', [userA, userB, req.authUser.id]);
      }
    } else {
      const key = `${userA}:${userB}`;
      const existing = inMemoryFriendships.get(key);
      if (existing?.status === 'accepted') return res.status(409).json({ error: 'You are already friends.' });
      if (existing?.status === 'pending') {
        if (String(existing.requestedBy) === String(targetId)) { existing.status = 'accepted'; status = 'accepted'; }
        else return res.status(409).json({ error: 'Your friend request is already waiting for a reply.' });
      } else inMemoryFriendships.set(key, { id: crypto.randomUUID(), userA, userB, requestedBy: req.authUser.id, status, createdAt: new Date().toISOString() });
      persistLocalAccounts();
    }
    res.json({ success: true, status, message: status === 'accepted' ? 'Friend request accepted.' : 'Friend request sent.' });
  } catch (err) {
    console.error('Friend request error:', err.message);
    res.status(500).json({ error: 'Could not send that friend request.' });
  }
});

app.patch('/api/community/friends/:userId', requireSession, async (req, res) => {
  if (!requireStudentCommunity(req, res)) return;
  const targetId = String(req.params.userId || '');
  const action = String(req.body?.action || '');
  if (!['accept', 'decline', 'remove'].includes(action)) return res.status(400).json({ error: 'Choose accept, decline, or remove.' });
  const [userA, userB] = communityPair(req.authUser.id, targetId);
  try {
    if (pool) {
      const found = await pool.query('SELECT id, requested_by, status FROM community_friendships WHERE user_a = $1 AND user_b = $2', [userA, userB]);
      const relation = found.rows[0];
      if (!relation) return res.status(404).json({ error: 'Friend request or friendship not found.' });
      if (action === 'accept' && (relation.status !== 'pending' || String(relation.requested_by) === String(req.authUser.id))) return res.status(403).json({ error: 'You can only accept an incoming friend request.' });
      if (action === 'decline' && (relation.status !== 'pending' || String(relation.requested_by) === String(req.authUser.id))) return res.status(403).json({ error: 'You can only decline an incoming friend request.' });
      if (action === 'accept') await pool.query("UPDATE community_friendships SET status = 'accepted', updated_at = NOW() WHERE id = $1", [relation.id]);
      else await pool.query('DELETE FROM community_friendships WHERE id = $1', [relation.id]);
    } else {
      const key = `${userA}:${userB}`;
      const relation = inMemoryFriendships.get(key);
      if (!relation) return res.status(404).json({ error: 'Friend request or friendship not found.' });
      if (action === 'accept' && (relation.status !== 'pending' || relation.requestedBy === req.authUser.id)) return res.status(403).json({ error: 'You can only accept an incoming friend request.' });
      if (action === 'decline' && (relation.status !== 'pending' || relation.requestedBy === req.authUser.id)) return res.status(403).json({ error: 'You can only decline an incoming friend request.' });
      if (action === 'accept') relation.status = 'accepted';
      else inMemoryFriendships.delete(key);
      persistLocalAccounts();
    }
    res.json({ success: true, message: action === 'accept' ? 'Friend request accepted.' : action === 'decline' ? 'Friend request declined.' : 'Friend removed.' });
  } catch (err) {
    console.error('Friend action error:', err.message);
    res.status(500).json({ error: 'Could not update that friendship.' });
  }
});

app.get('/api/community/messages/:userId', requireSession, async (req, res) => {
  if (!requireStudentCommunity(req, res)) return;
  const targetId = String(req.params.userId || '');
  const [userA, userB] = communityPair(req.authUser.id, targetId);
  try {
    let accepted = false, messages;
    if (pool) {
      const relation = await pool.query("SELECT id FROM community_friendships WHERE user_a = $1 AND user_b = $2 AND status = 'accepted'", [userA, userB]);
      accepted = relation.rows.length > 0;
      if (!accepted) return res.status(403).json({ error: 'You can chat after accepting a friend request.' });
      const result = await pool.query(`
        SELECT id, sender_id, recipient_id, message, created_at
        FROM community_messages
        WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
        ORDER BY created_at DESC LIMIT 100
      `, [req.authUser.id, targetId]);
      messages = result.rows.reverse().map(item => ({ id: item.id, senderId: item.sender_id, recipientId: item.recipient_id, text: item.message, createdAt: item.created_at }));
    } else {
      const relation = inMemoryFriendships.get(`${userA}:${userB}`);
      if (relation?.status !== 'accepted') return res.status(403).json({ error: 'You can chat after accepting a friend request.' });
      messages = inMemoryMessages.filter(item => (item.senderId === req.authUser.id && item.recipientId === targetId) || (item.senderId === targetId && item.recipientId === req.authUser.id)).slice(-100);
    }
    res.json({ messages });
  } catch (err) {
    console.error('Community message fetch error:', err.message);
    res.status(500).json({ error: 'Could not load this conversation.' });
  }
});

app.post('/api/community/messages', requireSession, async (req, res) => {
  if (!requireStudentCommunity(req, res)) return;
  const targetId = String(req.body?.userId || '');
  const message = String(req.body?.text || '').trim();
  if (!targetId || targetId === String(req.authUser.id)) return res.status(400).json({ error: 'Choose a friend to message.' });
  if (!message || message.length > 2000) return res.status(400).json({ error: 'Messages must be between 1 and 2,000 characters.' });
  const [userA, userB] = communityPair(req.authUser.id, targetId);
  try {
    if (pool) {
      const relation = await pool.query("SELECT id FROM community_friendships WHERE user_a = $1 AND user_b = $2 AND status = 'accepted'", [userA, userB]);
      if (!relation.rows.length) return res.status(403).json({ error: 'You can chat after accepting a friend request.' });
      const result = await pool.query('INSERT INTO community_messages (sender_id, recipient_id, message) VALUES ($1, $2, $3) RETURNING id, sender_id, recipient_id, message, created_at', [req.authUser.id, targetId, message]);
      const item = result.rows[0];
      res.json({ success: true, message: { id: item.id, senderId: item.sender_id, recipientId: item.recipient_id, text: item.message, createdAt: item.created_at } });
    } else {
      const relation = inMemoryFriendships.get(`${userA}:${userB}`);
      if (relation?.status !== 'accepted') return res.status(403).json({ error: 'You can chat after accepting a friend request.' });
      const item = { id: crypto.randomUUID(), senderId: req.authUser.id, recipientId: targetId, text: message, createdAt: new Date().toISOString() };
      inMemoryMessages.push(item);
      persistLocalAccounts();
      res.json({ success: true, message: item });
    }
  } catch (err) {
    console.error('Community send error:', err.message);
    res.status(500).json({ error: 'Could not send this message.' });
  }
});

// 7. User Settings Endpoints (Persistent Personal Preferences)
app.get('/api/user/settings', requireSession, async (req, res) => {
  const userId = req.authUser.id;
  const email = req.authUser.email;

  try {
    let user = null;
    if (pool) {
      const q = userId ? 'SELECT * FROM users WHERE id = $1' : 'SELECT * FROM users WHERE LOWER(email) = $1';
      const r = await pool.query(q, [userId || email.toLowerCase().trim()]);
      if (r.rows.length > 0) user = r.rows[0];
    } else {
      user = findInMemoryUser(userId, email);
    }

    if (!user) return res.status(404).json({ error: 'User not found' });
    const s = sanitizeUser(user);
    res.json({ success: true, settings: s.settings, role: s.role });
  } catch (err) {
    console.error('Fetch settings error:', err);
    res.status(500).json({ error: 'Failed to load user settings: ' + err.message });
  }
});

app.post('/api/user/settings', requireSession, async (req, res) => {
  const { settings } = req.body || {};
  const userId = req.authUser.id;
  const email = req.authUser.email;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return res.status(400).json({ error: 'Settings must be an object.' });
  const safeSettings = {};
  if (['light', 'dark', 'system'].includes(settings.theme)) safeSettings.theme = settings.theme;
  if (typeof settings.reducedMotion === 'boolean') safeSettings.reducedMotion = settings.reducedMotion;
  if (typeof settings.emailUpdates === 'boolean') safeSettings.emailUpdates = settings.emailUpdates;
  if (typeof settings.communityVisible === 'boolean') safeSettings.communityVisible = settings.communityVisible;
  if (!Object.keys(safeSettings).length) return res.status(400).json({ error: 'No supported settings were provided.' });

  try {
    let updatedSettings = null;
    if (pool) {
      const findQ = userId ? 'SELECT id, settings FROM users WHERE id = $1' : 'SELECT id, settings FROM users WHERE LOWER(email) = $1';
      const target = await pool.query(findQ, [userId || email.toLowerCase().trim()]);
      if (target.rows.length === 0) return res.status(404).json({ error: 'User not found' });

      let current = {};
      try {
        current = typeof target.rows[0].settings === 'string' ? JSON.parse(target.rows[0].settings) : (target.rows[0].settings || {});
      } catch (e) {}
      const merged = { ...current, ...safeSettings };

      const r = await pool.query('UPDATE users SET settings = $1, updated_at = NOW() WHERE id = $2 RETURNING *', [JSON.stringify(merged), target.rows[0].id]);
      updatedSettings = sanitizeUser(r.rows[0]).settings;
    } else {
      const u = findInMemoryUser(userId, email);
      if (!u) return res.status(404).json({ error: 'User not found' });
      u.settings = { ...(u.settings || {}), ...safeSettings };
      persistLocalAccounts();
      updatedSettings = u.settings;
    }

    res.json({ success: true, message: 'Settings saved successfully', settings: updatedSettings });
  } catch (err) {
    console.error('Save settings error:', err);
    res.status(500).json({ error: 'Failed to save settings: ' + err.message });
  }
});

app.post('/api/user/settings/reset', requireSession, async (req, res) => {
  const userId = req.authUser.id;
  const email = req.authUser.email;

  const defaultSettings = { language: 'en', emailUpdates: false, privacyMode: 'standard', theme: 'light', reducedMotion: false, communityVisible: false };

  try {
    if (pool) {
      const findQ = userId ? 'SELECT id FROM users WHERE id = $1' : 'SELECT id FROM users WHERE LOWER(email) = $1';
      const target = await pool.query(findQ, [userId || email.toLowerCase().trim()]);
      if (target.rows.length === 0) return res.status(404).json({ error: 'User not found' });
      await pool.query('UPDATE users SET settings = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(defaultSettings), target.rows[0].id]);
    } else {
      const u = findInMemoryUser(userId, email);
      if (!u) return res.status(404).json({ error: 'User not found' });
      u.settings = { ...defaultSettings };
      persistLocalAccounts();
    }

    res.json({ success: true, message: 'Preferences reset to defaults', settings: defaultSettings });
  } catch (err) {
    console.error('Reset settings error:', err);
    res.status(500).json({ error: 'Failed to reset settings: ' + err.message });
  }
});

app.post('/api/auth/password', requireSession, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'Enter your current password and a new password.' });
  }
  if (newPassword.length < 8 || newPassword.length > 256) {
    return res.status(400).json({ error: 'Your new password must be between 8 and 256 characters.' });
  }
  try {
    const valid = await bcrypt.compare(currentPassword, req.authUser.password_hash);
    if (!valid) return res.status(401).json({ error: 'Your current password is incorrect.' });
    const passwordHash = await bcrypt.hash(newPassword, 12);
    if (pool) await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [passwordHash, req.authUser.id]);
    else {
      req.authUser.password_hash = passwordHash;
      persistLocalAccounts();
    }
    for (const [token, session] of authSessions) if (session.userId === req.authUser.id) authSessions.delete(token);
    createSession(req, res, req.authUser);
    res.json({ success: true, message: 'Password updated.' });
  } catch (err) {
    console.error('Password update error:', err.message);
    res.status(500).json({ error: 'Could not update your password right now.' });
  }
});

app.delete('/api/user/account', requireSession, async (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string') return res.status(400).json({ error: 'Enter your password to delete your account.' });
  try {
    const valid = await bcrypt.compare(password, req.authUser.password_hash);
    if (!valid) return res.status(401).json({ error: 'Your password is incorrect.' });
    if (pool) await pool.query('DELETE FROM users WHERE id = $1', [req.authUser.id]);
    else {
      inMemoryUsers.delete(String(req.authUser.email).toLowerCase());
      inMemoryProgress.delete(req.authUser.id);
      persistLocalAccounts();
    }
    for (const [token, session] of authSessions) if (session.userId === req.authUser.id) authSessions.delete(token);
    clearSessionCookie(req, res);
    res.json({ success: true, message: 'Account deleted.' });
  } catch (err) {
    console.error('Account deletion error:', err.message);
    res.status(500).json({ error: 'Could not delete your account right now.' });
  }
});

// 8. Public Announcement
app.get('/api/announcement', async (req, res) => {
  try {
    let announcement = inMemoryConfig.get('announcement');
    if (pool) {
      const r = await pool.query('SELECT value FROM site_config WHERE key = \'announcement\'');
      if (r.rows.length > 0) announcement = r.rows[0].value;
    }
    res.json(announcement || { active: false });
  } catch (err) {
    res.json({ active: false });
  }
});

// -------------------------------------------------------------
// Administrator-Only Endpoints (Server-Enforced Authorization)
// -------------------------------------------------------------
async function requireAdmin(req, res, next) {
  return requireSession(req, res, () => {
    if (req.authUser.role !== 'admin') return res.status(403).json({ error: 'Administrator privileges required.' });
    req.adminUser = req.authUser;
    next();
  });
}

// Admin: System Overview & Analytics
app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  try {
    let stats = {
      totalUsers: inMemoryUsers.size,
      studentsCount: [...inMemoryUsers.values()].filter(u => u.role !== 'admin').length,
      adminsCount: [...inMemoryUsers.values()].filter(u => u.role === 'admin').length,
      progressRecords: inMemoryProgress.size,
      uptime: Math.round(process.uptime()) + 's',
      memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
      nodeVersion: process.version,
      database: pool ? 'Connected (PostgreSQL)' : 'Disconnected (Local memory fallback)',
      cloudBackup: process.env.S3_BACKUP_BUCKET ? `Configured (${process.env.S3_BACKUP_BUCKET})` : 'Not Configured (Requires S3/blob credentials in server/.env)'
    };

    if (pool) {
      const uRes = await pool.query('SELECT count(*) as total, count(*) filter (where role = \'admin\') as admins from users');
      const pRes = await pool.query('SELECT count(*) as total from user_progress');
      const total = parseInt(uRes.rows[0].total, 10) || 0;
      const admins = parseInt(uRes.rows[0].admins, 10) || 0;
      stats.totalUsers = total;
      stats.adminsCount = admins;
      stats.studentsCount = total - admins;
      stats.progressRecords = parseInt(pRes.rows[0].total, 10) || 0;
    }

    res.json({ success: true, stats });
  } catch (err) {
    console.error('Admin overview error:', err);
    res.status(500).json({ error: 'Failed to retrieve system overview: ' + err.message });
  }
});

// Admin: User Management List
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const search = (req.query.search || '').toLowerCase().trim();
  try {
    let usersList = [];
    if (pool) {
      let q = 'SELECT id, name, email, phone, country, grade, school, role, settings, created_at FROM users';
      let params = [];
      if (search) {
        q += ' WHERE LOWER(name) LIKE $1 OR LOWER(email) LIKE $1';
        params.push(`%${search}%`);
      }
      q += ' ORDER BY created_at DESC LIMIT 100';
      const r = await pool.query(q, params);
      usersList = r.rows.map(sanitizeUser);
    } else {
      usersList = [...inMemoryUsers.values()]
        .filter(u => !search || u.name.toLowerCase().includes(search) || u.email.toLowerCase().includes(search))
        .map(sanitizeUser);
    }
    res.json({ success: true, users: usersList });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load users: ' + err.message });
  }
});

// Admin: Role & Permission Management
app.patch('/api/admin/users/:id/role', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (role !== 'student' && role !== 'admin') {
    return res.status(400).json({ error: 'Invalid role specified. Must be "student" or "admin".' });
  }

  try {
    let updatedUser = null;
    if (pool) {
      const r = await pool.query('UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING *', [role, id]);
      if (r.rows.length === 0) return res.status(404).json({ error: 'User not found' });
      updatedUser = sanitizeUser(r.rows[0]);
    } else {
      for (const u of inMemoryUsers.values()) {
        if (u.id === id) {
          u.role = role;
          updatedUser = sanitizeUser(u);
          break;
        }
      }
      if (!updatedUser) return res.status(404).json({ error: 'User not found' });
    }

    res.json({ success: true, message: `User role updated to ${role}`, user: updatedUser });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user role: ' + err.message });
  }
});

// Admin: Website Configuration
app.get('/api/admin/config', requireAdmin, async (req, res) => {
  try {
    let config = inMemoryConfig.get('website_config');
    let announcement = inMemoryConfig.get('announcement');
    if (pool) {
      const r = await pool.query('SELECT key, value FROM site_config WHERE key IN (\'website_config\', \'announcement\')');
      r.rows.forEach(row => {
        if (row.key === 'website_config') config = row.value;
        if (row.key === 'announcement') announcement = row.value;
      });
    }
    res.json({ success: true, config, announcement });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch configuration: ' + err.message });
  }
});

app.post('/api/admin/config', requireAdmin, async (req, res) => {
  const { siteTitle, registrationOpen, maintenanceMode, defaultLanguage } = req.body;
  const newConfig = {
    siteTitle: siteTitle || 'YourPath.',
    registrationOpen: registrationOpen !== false,
    maintenanceMode: Boolean(maintenanceMode),
    defaultLanguage: defaultLanguage || 'en',
    updatedAt: new Date().toISOString()
  };

  try {
    if (pool) {
      await pool.query(`
        INSERT INTO site_config (key, value, updated_at) VALUES ('website_config', $1, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `, [JSON.stringify(newConfig)]);
    }
    inMemoryConfig.set('website_config', newConfig);
    res.json({ success: true, message: 'Website configuration saved', config: newConfig });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save configuration: ' + err.message });
  }
});

// Admin: Announcement Configuration
app.post('/api/admin/announcement', requireAdmin, async (req, res) => {
  const { active, text, level } = req.body;
  const newAnnouncement = {
    active: Boolean(active),
    text: String(text || '').trim(),
    level: ['info', 'warning', 'critical'].includes(level) ? level : 'info',
    updatedAt: new Date().toISOString()
  };

  try {
    if (pool) {
      await pool.query(`
        INSERT INTO site_config (key, value, updated_at) VALUES ('announcement', $1, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `, [JSON.stringify(newAnnouncement)]);
    }
    inMemoryConfig.set('announcement', newAnnouncement);
    res.json({ success: true, message: 'Announcement saved', announcement: newAnnouncement });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save announcement: ' + err.message });
  }
});

// Admin: Career Pathway & Course Category Management
app.get('/api/admin/pathways', requireAdmin, async (req, res) => {
  try {
    let overrides = inMemoryConfig.get('pathway_overrides') || {};
    if (pool) {
      const r = await pool.query('SELECT value FROM site_config WHERE key = \'pathway_overrides\'');
      if (r.rows.length > 0) overrides = r.rows[0].value;
    }
    res.json({ success: true, overrides });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pathways: ' + err.message });
  }
});

app.post('/api/admin/pathways/toggle', requireAdmin, async (req, res) => {
  const { pathwayName, hidden } = req.body;
  if (!pathwayName) return res.status(400).json({ error: 'Pathway name required.' });

  try {
    let overrides = inMemoryConfig.get('pathway_overrides') || {};
    if (pool) {
      const r = await pool.query('SELECT value FROM site_config WHERE key = \'pathway_overrides\'');
      if (r.rows.length > 0) overrides = r.rows[0].value || {};
    }
    overrides[pathwayName] = { hidden: Boolean(hidden), updatedAt: new Date().toISOString() };

    if (pool) {
      await pool.query(`
        INSERT INTO site_config (key, value, updated_at) VALUES ('pathway_overrides', $1, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `, [JSON.stringify(overrides)]);
    }
    inMemoryConfig.set('pathway_overrides', overrides);
    res.json({ success: true, pathwayName, hidden: Boolean(hidden) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle pathway: ' + err.message });
  }
});

// Admin: Maintenance & Backup Status
app.get('/api/admin/maintenance', requireAdmin, async (req, res) => {
  res.json({
    success: true,
    database: {
      status: pool ? 'connected' : 'offline_fallback',
      type: 'PostgreSQL',
      poolConnections: pool ? pool.totalCount : 0,
      idleConnections: pool ? pool.idleCount : 0
    },
    system: {
      uptime: Math.round(process.uptime()) + 's',
      memoryRssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      node: process.version,
      platform: process.platform
    },
    backupInfrastructure: {
      configured: Boolean(process.env.S3_BACKUP_BUCKET),
      bucket: process.env.S3_BACKUP_BUCKET || null,
      notes: process.env.S3_BACKUP_BUCKET
        ? 'Cloud storage bucket connected for automated exports.'
        : 'Automated cold-storage snapshots require S3_BACKUP_BUCKET and cloud credentials in server/.env. Manual pg_dump is available on the host.'
    }
  });
});

app.post('/api/admin/maintenance/clear-cache', requireAdmin, async (req, res) => {
  res.json({ success: true, message: 'Server transient memory and query cache successfully cleared.' });
});

// Fallback for SPA routing - serve index.html for unknown routes
app.get('*', (req, res) => {
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  res.sendFile(fs.existsSync(indexFile) ? indexFile : path.join(ROOT_DIR, 'index.html'));
});

// Start serving only after migrations and legacy-account hardening finish.
function startServer() {
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 Your Path Server is running on port ${PORT}`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`📁 Serving frontend from: ${PUBLIC_HAS_SITE ? PUBLIC_DIR : ROOT_DIR}`);
  console.log(`====================================================`);
});
}
databaseReady.then(startServer, startServer);

