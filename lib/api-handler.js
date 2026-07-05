const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PASSWORD_KEY_LENGTH = 64;
const SCRYPT_COST = 16384;
const CHARACTER_UNLOCK_SCORES = [0, 250, 600, 1000, 1500, 2100, 2800, 3600, 4500, 5500, 6600, 7800, 9100, 10500];

let pool;

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  let raw = '';
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] ||= value;
  }
}

function normalizeConnectionString(raw) {
  if (!raw) return raw;
  const passwordMatch = raw.match(/^(postgres(?:ql)?:\/\/[^:]+):([^@]+)@(.+)$/);
  if (!passwordMatch) return raw;
  const password = passwordMatch[2];
  const unquoted = password.startsWith('"') && password.endsWith('"') ? password.slice(1, -1) : password;
  return `${passwordMatch[1]}:${encodeURIComponent(decodeURIComponent(unquoted))}@${passwordMatch[3]}`;
}

function getPool() {
  if (pool) return pool;
  loadEnv();
  const connectionString = normalizeConnectionString(
    process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.DIRECT_CONNECTION_KEY
  );
  if (!connectionString) throw new Error('Missing DATABASE_URL');
  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 5
  });
  return pool;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  if (raw.length > 1024 * 32) throw Object.assign(new Error('Payload too large'), { status: 413 });
  return JSON.parse(raw);
}

function normalizeUsername(username) {
  return String(username || '').trim();
}

function validateUsername(username) {
  return username.length >= 2 && username.length <= 16 && /^[a-zA-Z0-9_]+$/.test(username);
}

function unlockedIndexForScore(score) {
  const cleanScore = Math.max(0, Math.floor(Number(score || 0)));
  let index = 0;
  for (let i = 0; i < CHARACTER_UNLOCK_SCORES.length; i += 1) {
    if (cleanScore >= CHARACTER_UNLOCK_SCORES[i]) index = i;
  }
  return index;
}

function toUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    usernameKey: row.username_key,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    bestScore: row.best_score || 0,
    bestChar: row.best_char || null,
    bestAt: row.best_at || null,
    activeCharId: row.active_char_id || 'c0',
    highestUnlockedIndex: Number.isInteger(row.highest_unlocked_index) ? row.highest_unlocked_index : 0,
    createdAt: row.created_at || null
  };
}

function ensureUserProgress(user) {
  const derivedIndex = unlockedIndexForScore(user.bestScore || 0);
  const currentIndex = Number.isInteger(user.highestUnlockedIndex) ? user.highestUnlockedIndex : 0;
  const maxIndex = Math.min(Math.max(currentIndex, derivedIndex), CHARACTER_UNLOCK_SCORES.length - 1);
  user.highestUnlockedIndex = maxIndex;

  if (!user.activeCharId || !/^c\d+$/.test(String(user.activeCharId))) {
    user.activeCharId = `c${maxIndex}`;
  }
  const activeIndex = Number(String(user.activeCharId).slice(1));
  if (!Number.isFinite(activeIndex) || activeIndex > maxIndex) {
    user.activeCharId = `c${maxIndex}`;
  }
  return user;
}

function publicUser(user) {
  return {
    username: user.username,
    bestScore: user.bestScore || 0,
    bestChar: user.bestChar || null,
    bestAt: user.bestAt || null,
    createdAt: user.createdAt,
    activeCharId: user.activeCharId || 'c0',
    highestUnlockedIndex: Number.isInteger(user.highestUnlockedIndex) ? user.highestUnlockedIndex : 0
  };
}

async function saveProgress(client, user) {
  await client.query(
    `
      update public.runner_users
      set active_char_id = $2,
          highest_unlocked_index = $3
      where id = $1
    `,
    [user.id, user.activeCharId, user.highestUnlockedIndex]
  );
}

async function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, PASSWORD_KEY_LENGTH, { N: SCRYPT_COST }, (error, key) => {
      if (error) reject(error);
      else resolve(key.toString('hex'));
    });
  });
}

async function verifyPassword(password, user) {
  const hash = await hashPassword(password, user.passwordSalt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.passwordHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

async function getUserByToken(client, req) {
  const token = getBearerToken(req);
  if (!token) return null;
  const result = await client.query(
    `
      select u.*
      from public.runner_sessions s
      join public.runner_users u on u.id = s.user_id
      where s.token = $1
    `,
    [token]
  );
  if (!result.rows[0]) return null;
  await client.query('update public.runner_sessions set last_seen_at = now() where token = $1', [token]);
  return { token, user: ensureUserProgress(toUser(result.rows[0])) };
}

async function touchPresence(client, userId) {
  await client.query(
    `
      insert into public.runner_presence (user_id, last_seen_at)
      values ($1, now())
      on conflict (user_id) do update set last_seen_at = excluded.last_seen_at
    `,
    [userId]
  );
}

async function handleRegister(req, res, client) {
  const body = await readJson(req);
  const username = normalizeUsername(body.username);
  const password = String(body.password || '');
  const usernameKey = username.toLowerCase();

  if (!validateUsername(username)) return json(res, 400, { error: 'letters, numbers, underscores only; 2-16 characters' });
  if (password.length < 4 || password.length > 128) return json(res, 400, { error: 'password must be 4-128 characters' });

  const salt = crypto.randomBytes(16).toString('hex');
  const token = crypto.randomBytes(32).toString('hex');
  const passwordHash = await hashPassword(password, salt);

  try {
    const result = await client.query(
      `
        insert into public.runner_users (
          username, username_key, password_salt, password_hash,
          best_score, active_char_id, highest_unlocked_index
        )
        values ($1,$2,$3,$4,0,'c0',0)
        returning *
      `,
      [username, usernameKey, salt, passwordHash]
    );
    const user = ensureUserProgress(toUser(result.rows[0]));
    await client.query(
      'insert into public.runner_sessions (token, user_id, created_at, last_seen_at) values ($1,$2,now(),now())',
      [token, user.id]
    );
    await touchPresence(client, user.id);
    return json(res, 201, { token, user: publicUser(user) });
  } catch (error) {
    if (error.code === '23505') return json(res, 409, { error: 'username already taken' });
    throw error;
  }
}

async function handleLogin(req, res, client) {
  const body = await readJson(req);
  const usernameKey = normalizeUsername(body.username).toLowerCase();
  const password = String(body.password || '');
  const result = await client.query('select * from public.runner_users where username_key = $1', [usernameKey]);
  const user = toUser(result.rows[0]);

  if (!user || !(await verifyPassword(password, user))) {
    return json(res, 401, { error: 'incorrect username or password' });
  }

  ensureUserProgress(user);
  await saveProgress(client, user);
  const token = crypto.randomBytes(32).toString('hex');
  await client.query(
    'insert into public.runner_sessions (token, user_id, created_at, last_seen_at) values ($1,$2,now(),now())',
    [token, user.id]
  );
  await touchPresence(client, user.id);
  return json(res, 200, { token, user: publicUser(user) });
}

async function handleProgress(req, res, client) {
  const body = await readJson(req);
  const score = Math.max(0, Math.floor(Number(body.score || 0)));
  const requestedCharId = String(body.activeCharId || '').trim();
  const auth = await getUserByToken(client, req);
  if (!auth) return json(res, 401, { error: 'not authenticated' });

  const user = auth.user;
  const previousIndex = user.highestUnlockedIndex || 0;
  const nextIndex = Math.max(previousIndex, unlockedIndexForScore(score));
  let unlockedCharId = null;

  if (nextIndex > previousIndex) {
    user.highestUnlockedIndex = nextIndex;
    unlockedCharId = `c${nextIndex}`;
    user.activeCharId = unlockedCharId;
  }

  if (requestedCharId) {
    const requestedIndex = Number(requestedCharId.slice(1));
    if (Number.isFinite(requestedIndex) && requestedIndex <= user.highestUnlockedIndex) {
      user.activeCharId = requestedCharId;
    }
  }

  await saveProgress(client, user);
  await touchPresence(client, user.id);
  return json(res, 200, {
    user: publicUser(user),
    unlockedCharId,
    highestUnlockedIndex: user.highestUnlockedIndex
  });
}

async function handleScore(req, res, client) {
  const body = await readJson(req);
  const score = Math.max(0, Math.floor(Number(body.score || 0)));
  const character = String(body.character || '').slice(0, 64);
  const activeCharId = String(body.activeCharId || '').trim();
  const auth = await getUserByToken(client, req);
  if (!auth) return json(res, 401, { error: 'not authenticated' });

  const user = auth.user;
  const previousBest = user.bestScore || 0;
  const isNewBest = score > previousBest;
  if (isNewBest) {
    user.bestScore = score;
    user.bestChar = character || null;
    user.bestAt = new Date();
  }

  const previousUnlockIndex = user.highestUnlockedIndex || 0;
  const progressIndex = unlockedIndexForScore(score);
  if (progressIndex > user.highestUnlockedIndex) user.highestUnlockedIndex = progressIndex;

  const requestedIndex = Number(activeCharId.slice(1));
  if (progressIndex > previousUnlockIndex) {
    user.activeCharId = `c${user.highestUnlockedIndex}`;
  } else if (Number.isFinite(requestedIndex) && requestedIndex <= user.highestUnlockedIndex) {
    user.activeCharId = activeCharId;
  } else {
    user.activeCharId = `c${user.highestUnlockedIndex}`;
  }

  await client.query(
    `
      update public.runner_users
      set best_score = $2,
          best_char = $3,
          best_at = $4,
          active_char_id = $5,
          highest_unlocked_index = $6
      where id = $1
    `,
    [user.id, user.bestScore, user.bestChar, user.bestAt, user.activeCharId, user.highestUnlockedIndex]
  );
  await touchPresence(client, user.id);
  return json(res, 200, { user: publicUser(user), previousBest, isNewBest });
}

async function handleApi(req, res, pathname) {
  const client = await getPool().connect();
  try {
    if (req.method === 'POST' && pathname === '/api/register') return await handleRegister(req, res, client);
    if (req.method === 'POST' && pathname === '/api/login') return await handleLogin(req, res, client);

    if (req.method === 'POST' && pathname === '/api/logout') {
      const token = getBearerToken(req);
      if (token) await client.query('delete from public.runner_sessions where token = $1', [token]);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/me') {
      const auth = await getUserByToken(client, req);
      if (!auth) return json(res, 401, { error: 'not authenticated' });
      await saveProgress(client, auth.user);
      return json(res, 200, { user: publicUser(auth.user) });
    }

    if (req.method === 'POST' && pathname === '/api/progress') return await handleProgress(req, res, client);
    if (req.method === 'POST' && pathname === '/api/score') return await handleScore(req, res, client);

    if (req.method === 'POST' && pathname === '/api/presence') {
      const auth = await getUserByToken(client, req);
      if (auth) await touchPresence(client, auth.user.id);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/leaderboard') {
      const result = await client.query(
        'select * from public.runner_users order by best_score desc limit 10'
      );
      return json(res, 200, { leaderboard: result.rows.map(row => publicUser(ensureUserProgress(toUser(row)))) });
    }

    if (req.method === 'GET' && pathname === '/api/stats') {
      const total = await client.query('select count(*)::int as total from public.runner_users');
      const online = await client.query(
        "select count(*)::int as online from public.runner_presence where last_seen_at > now() - interval '25 seconds'"
      );
      return json(res, 200, { totalPlayers: total.rows[0].total, online: online.rows[0].online });
    }

    return json(res, 404, { error: 'not found' });
  } catch (error) {
    if (error instanceof SyntaxError) return json(res, 400, { error: 'invalid JSON' });
    console.error(error);
    return json(res, error.status || 500, { error: 'server error' });
  } finally {
    client.release();
  }
}

module.exports = { handleApi };
