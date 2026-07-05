const fs = require('fs/promises');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'data', 'db.json');

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  let raw = '';
  try {
    raw = require('fs').readFileSync(envPath, 'utf8');
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

function getConnectionString() {
  const raw = process.env.DATABASE_URL
  if (!raw) return raw;

  const passwordMatch = raw.match(/^(postgres(?:ql)?:\/\/[^:]+):([^@]+)@(.+)$/);
  if (passwordMatch) {
    const password = passwordMatch[2];
    const unquoted = password.startsWith('"') && password.endsWith('"') ? password.slice(1, -1) : password;
    return `${passwordMatch[1]}:${encodeURIComponent(decodeURIComponent(unquoted))}@${passwordMatch[3]}`;
  }

  try {
    new URL(raw);
    return raw;
  } catch (error) {
    const quotedPassword = raw.match(/^(postgres(?:ql)?:\/\/[^:]+):"([^"]+)"@(.+)$/);
    if (quotedPassword) {
      return `${quotedPassword[1]}:${encodeURIComponent(quotedPassword[2])}@${quotedPassword[3]}`;
    }
    throw error;
  }
}

async function readLocalDb() {
  try {
    return JSON.parse(await fs.readFile(DB_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { users: {}, sessions: {}, presence: {} };
    throw error;
  }
}

async function createSchema(client) {
  await client.query(`
    create extension if not exists pgcrypto;

    create table if not exists public.runner_users (
      id uuid primary key default gen_random_uuid(),
      username text not null unique,
      username_key text not null unique,
      password_salt text not null,
      password_hash text not null,
      best_score integer not null default 0,
      best_char text,
      best_at timestamptz,
      active_char_id text not null default 'c0',
      highest_unlocked_index integer not null default 0,
      created_at timestamptz not null default now()
    );

    create table if not exists public.runner_sessions (
      token text primary key,
      user_id uuid not null references public.runner_users(id) on delete cascade,
      created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now()
    );

    create table if not exists public.runner_presence (
      user_id uuid primary key references public.runner_users(id) on delete cascade,
      last_seen_at timestamptz not null default now()
    );

    create index if not exists runner_users_best_score_idx
      on public.runner_users (best_score desc);

    create index if not exists runner_sessions_user_id_idx
      on public.runner_sessions (user_id);
  `);
}

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function migrateLocalData(client) {
  const db = await readLocalDb();
  const userIds = new Map();

  for (const [usernameKey, user] of Object.entries(db.users || {})) {
    const result = await client.query(
      `
        insert into public.runner_users (
          username,
          username_key,
          password_salt,
          password_hash,
          best_score,
          best_char,
          best_at,
          active_char_id,
          highest_unlocked_index,
          created_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        on conflict (username_key) do update set
          username = excluded.username,
          password_salt = excluded.password_salt,
          password_hash = excluded.password_hash,
          best_score = greatest(public.runner_users.best_score, excluded.best_score),
          best_char = coalesce(excluded.best_char, public.runner_users.best_char),
          best_at = coalesce(excluded.best_at, public.runner_users.best_at),
          active_char_id = excluded.active_char_id,
          highest_unlocked_index = greatest(public.runner_users.highest_unlocked_index, excluded.highest_unlocked_index)
        returning id
      `,
      [
        user.username,
        usernameKey,
        user.passwordSalt,
        user.passwordHash,
        user.bestScore || 0,
        user.bestChar || null,
        toDate(user.bestAt),
        user.activeCharId || 'c0',
        Number.isInteger(user.highestUnlockedIndex) ? user.highestUnlockedIndex : 0,
        toDate(user.createdAt) || new Date()
      ]
    );
    userIds.set(usernameKey, result.rows[0].id);
  }

  for (const [token, session] of Object.entries(db.sessions || {})) {
    const userId = userIds.get(session.usernameKey);
    if (!userId) continue;
    await client.query(
      `
        insert into public.runner_sessions (token, user_id, created_at, last_seen_at)
        values ($1,$2,$3,$4)
        on conflict (token) do update set
          user_id = excluded.user_id,
          last_seen_at = excluded.last_seen_at
      `,
      [
        token,
        userId,
        toDate(session.createdAt) || new Date(),
        toDate(session.lastSeenAt) || new Date()
      ]
    );
  }

  for (const [usernameKey, timestamp] of Object.entries(db.presence || {})) {
    const userId = userIds.get(usernameKey);
    if (!userId) continue;
    await client.query(
      `
        insert into public.runner_presence (user_id, last_seen_at)
        values ($1,$2)
        on conflict (user_id) do update set last_seen_at = excluded.last_seen_at
      `,
      [userId, toDate(timestamp) || new Date()]
    );
  }

  return {
    users: Object.keys(db.users || {}).length,
    sessions: Object.keys(db.sessions || {}).length,
    presence: Object.keys(db.presence || {}).length
  };
}

async function main() {
  loadEnv();
  const connectionString = getConnectionString();
  if (!connectionString) {
    throw new Error('Missing DIRECT_CONNECTION_KEY, DATABASE_URL, or POSTGRES_URL in .env');
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  try {
    await createSchema(client);
    const migrated = await migrateLocalData(client);
    const count = await client.query('select count(*)::int as total from public.runner_users');
    console.log(`Supabase schema ready. Migrated ${migrated.users} local users. Total users in Supabase: ${count.rows[0].total}.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
