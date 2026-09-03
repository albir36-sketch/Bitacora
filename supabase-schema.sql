-- Ejecuta esto una sola vez en Supabase: SQL Editor > New query > pega y dale "Run"

create table if not exists trades (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  type text not null,               -- 'stock' | 'option'
  ticker text not null,
  date date not null,
  qty numeric not null,
  price numeric,                    -- solo para acciones
  action text,                      -- 'buy' | 'sell' (solo acciones)
  legs jsonb,                       -- array de patas (solo opciones/spreads)
  status text,                      -- 'open' | 'closed' (solo opciones)
  close_date date,
  notes text,
  created_at timestamptz default now()
);

alter table trades enable row level security;

create policy "own trades select" on trades for select using (auth.uid() = user_id);
create policy "own trades insert" on trades for insert with check (auth.uid() = user_id);
create policy "own trades update" on trades for update using (auth.uid() = user_id);
create policy "own trades delete" on trades for delete using (auth.uid() = user_id);

create table if not exists current_prices (
  user_id uuid references auth.users not null,
  ticker text not null,
  price numeric not null,
  primary key (user_id, ticker)
);

alter table current_prices enable row level security;

create policy "own prices select" on current_prices for select using (auth.uid() = user_id);
create policy "own prices insert" on current_prices for insert with check (auth.uid() = user_id);
create policy "own prices update" on current_prices for update using (auth.uid() = user_id);
create policy "own prices delete" on current_prices for delete using (auth.uid() = user_id);
