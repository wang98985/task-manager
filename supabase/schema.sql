-- 在 Supabase 控制台的 SQL Editor 中执行本文件

create extension if not exists pgcrypto;

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  priority text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  completed boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists tasks_created_at_idx on public.tasks (created_at desc);

-- 允许服务端密钥直接访问；若改用 anon key，则需要下面的策略
alter table public.tasks enable row level security;

drop policy if exists "tasks_public_access" on public.tasks;
create policy "tasks_public_access" on public.tasks
  for all
  to anon, authenticated
  using (true)
  with check (true);

grant select, insert, update, delete on public.tasks to anon, authenticated;
