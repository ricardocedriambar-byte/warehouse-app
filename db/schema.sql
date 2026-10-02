-- db/schema.sql
--
-- Fase 1 da migração Google Sheets → Supabase (Postgres): artigos/stock,
-- encomendas e o histórico de alterações (StockLog). Clientes, utilizadores,
-- push e as abas pequenas (MateriaisPortas, LogosFornecedores, …) continuam
-- no Google Sheets nesta fase.
--
-- Idempotente: pode ser corrido mais do que uma vez. Já aplicado no projeto
-- Supabase "cedriambar-db" (migrações fase1_artigos_stocklog + fase1_encomendas).
--
-- Segurança: RLS ligado em todas as tabelas SEM políticas — a API pública do
-- Supabase (anon key / PostgREST) não consegue ler nem escrever nada. Só o
-- servidor (Vercel), ligado diretamente com DATABASE_URL, tem acesso.

-- ─── Artigos (antiga aba "Etiquetas") ───────────────────────────────────────
create table if not exists artigos (
  id             bigserial primary key,          -- exposto à app como "rowNumber"
  sku            text        not null unique,     -- sempre 8 dígitos, zeros à esquerda
  familia        text        not null default '',
  descricao      text        not null default '',
  comprimento    numeric,
  largura        numeric,
  espessura      numeric,
  dimensao_m2    numeric,                          -- m² por peça (painéis vendidos ao m²)
  valor_compra   numeric,
  preco          numeric,
  stock          numeric,                          -- peças físicas
  observacoes    text        not null default '',
  qr             text        not null default '',
  unidade        text        not null default 'un',
  reservado      numeric     not null default 0 check (reservado >= 0),
  stock_minimo   numeric,                          -- vazio = sem alerta
  ordem          bigint,                           -- ordem original na folha (mantém a ordenação da app)
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now()
);
create index if not exists artigos_ordem_idx on artigos (ordem, id);

-- ─── Histórico (antiga aba "StockLog") ──────────────────────────────────────
create table if not exists stock_log (
  id              bigserial primary key,
  ts              timestamptz not null default now(),
  sku             text        not null default '',
  descricao       text        not null default '',
  campo           text        not null default '',
  valor_anterior  text        not null default '',
  valor_novo      text        not null default '',
  nota            text        not null default ''
);
create index if not exists stock_log_sku_idx on stock_log (sku, ts desc);
create index if not exists stock_log_ts_idx on stock_log (ts desc);

-- ─── Encomendas (antiga aba "Encomendas", agora cabeçalho + linhas) ─────────
create table if not exists encomendas (
  order_id     text        primary key,           -- ENC-YYYYMMDD-XXXX
  client_id    text        not null default '',
  client_name  text        not null default '',
  status       text        not null default 'Rascunho'
               check (status in ('Rascunho','Enviado','Em separação','Concluído','Cancelado')),
  created_at   timestamptz not null default now(),
  salesperson  text        not null default '',
  order_notes  text        not null default '',
  order_type   text        not null default 'Normal' check (order_type in ('Normal','Portas')),
  doors_data   jsonb,
  edited_by    text        not null default '',
  edited_at    timestamptz
);
create index if not exists encomendas_status_idx on encomendas (status);
create index if not exists encomendas_created_idx on encomendas (created_at);

create table if not exists encomenda_linhas (
  id              bigserial primary key,
  order_id        text        not null references encomendas(order_id) on delete cascade,
  posicao         int         not null,           -- = lineIndex na app
  sku             text        not null default '',
  descricao       text        not null default '',
  comprimento     numeric,
  largura         numeric,
  espessura       numeric,
  unidade         text        not null default 'un',
  qty_ordered     numeric     not null default 0,  -- na unidade de preço (ex.: m²)
  qty_picked      numeric     not null default 0,
  unit_price      numeric,
  line_total      numeric,
  line_notes      text        not null default '',
  discount_pct    numeric     not null default 0,
  qty_mode        text        not null default '',
  qty_entered     numeric,
  line_status     text        not null default ''
                  check (line_status in ('','Encomendado','Em produção','Recebido')),
  line_status_at  timestamptz,
  unique (order_id, posicao)
);
create index if not exists encomenda_linhas_sku_idx on encomenda_linhas (sku);
create index if not exists encomenda_linhas_order_idx on encomenda_linhas (order_id);

-- ─── updated_at automático nos artigos ─────────────────────────────────────
create or replace function artigos_touch() returns trigger language plpgsql
set search_path = ''
as $$
begin new.atualizado_em := now(); return new; end $$;
create or replace trigger artigos_touch before update on artigos for each row execute function artigos_touch();

-- ─── Bloquear a API pública do Supabase ─────────────────────────────────────
alter table artigos           enable row level security;
alter table stock_log         enable row level security;
alter table encomendas        enable row level security;
alter table encomenda_linhas  enable row level security;
