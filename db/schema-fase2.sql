-- db/schema-fase2.sql
--
-- Fase 2 da migração Google Sheets → Supabase: clientes, utilizadores,
-- subscrições push e as abas pequenas (MateriaisPortas, LogosFornecedores,
-- PriceSyncStatus, J5F_Ignorar). Depois desta fase a app já não lê nem
-- escreve no Google Sheets — só usa o Google Drive (TABELA.xlsx e Recursos).
--
-- Idempotente. Mesma regra de segurança da fase 1: RLS ligado sem políticas,
-- só o servidor (DATABASE_URL) acede.

create table if not exists clientes (
  id         text primary key,                 -- código J5F ou CLI-<timestamp>
  nome       text not null default '',
  morada     text not null default '',
  telefone   text not null default '',
  email      text not null default '',
  notas      text not null default '',         -- NIF continua dentro das notas ("NIF: …")
  ordem      bigint,
  criado_em  timestamptz not null default now()
);
create index if not exists clientes_ordem_idx on clientes (ordem, criado_em);

create table if not exists utilizadores (
  id               text primary key,
  nome             text not null default '',
  role             text not null default 'vendedor' check (role in ('vendedor','armazém','admin')),
  ativo            boolean not null default true,
  email            text not null default '',
  notify_orders    boolean not null default false,
  notify_lowstock  boolean not null default false,
  default_tab      text not null default '',
  avatar_color     text not null default '',
  avatar_photo     text not null default '',
  ordem            bigint,
  criado_em        timestamptz not null default now()
);

create table if not exists push_subscriptions (
  id          text primary key,
  user_id     text not null default '',
  endpoint    text not null unique,
  p256dh      text not null default '',
  auth        text not null default '',
  user_agent  text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id);

create table if not exists materiais_portas (
  posicao  int primary key,
  nome     text not null
);

create table if not exists logos_fornecedores (
  fornecedor  text primary key,
  logo_url    text not null
);

create table if not exists price_sync_status (
  id       int primary key default 1 check (id = 1),
  run_at   timestamptz not null default now(),
  summary  jsonb
);

create table if not exists j5f_ignorar (
  sku        text primary key,
  descricao  text not null default ''
);

alter table clientes            enable row level security;
alter table utilizadores        enable row level security;
alter table push_subscriptions  enable row level security;
alter table materiais_portas    enable row level security;
alter table logos_fornecedores  enable row level security;
alter table price_sync_status   enable row level security;
alter table j5f_ignorar         enable row level security;
