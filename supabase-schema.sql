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
