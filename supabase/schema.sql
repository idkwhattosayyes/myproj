-- ============================================================
-- myproj — схема Supabase
--
-- Куда вставлять: Supabase Dashboard → раздел "SQL Editor" (слева
-- в меню) → кнопка "New query" → вставить весь файл целиком → Run.
-- Больше ничего вручную создавать не нужно — весь DDL самодостаточен.
--
-- Этот файл создаёт таблицы в облаке. src/data/supabaseAdapter.js уже
-- активно использует notes/folders/*_links/tags/blocks/block_tags/
-- favorites/pins для залогиненных пользователей (см. storageAdapter.js —
-- гибридный роутинг). images/drawings пока не задействованы — ждут
-- своего модуля. Миграция существующих localStorage-данных в облако
-- сюда не входит.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- notes
-- ------------------------------------------------------------
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '',
  content text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  open_at_end boolean not null default false,
  page_mode text not null default 'flow' check (page_mode in ('flow', 'paged')),
  deleted_at timestamptz,
  -- Порядок в списке (drag-and-drop) и момент последней правки текста/заголовка
  -- (отдельно от updated_at — реордер меняет sort_order, но не должен считаться
  -- "правкой" для сортировки "недавно изменённые"). Оба явно выставляются
  -- адаптером (src/data/supabaseAdapter.js), автотриггера на updated_at
  -- намеренно нет — иначе точечное обновление sort_order тоже трогало бы его.
  sort_order bigint not null default 0,
  activity_at timestamptz not null default now()
);

create index notes_user_id_idx on public.notes(user_id);
-- partial-индексы под реальные запросы адаптера (активный список / Корзина,
-- каждый со своей сортировкой) — см. 006_performance_indexes.sql
create index notes_active_sort_idx on public.notes(user_id, sort_order) where deleted_at is null;
create index notes_trashed_deleted_idx on public.notes(user_id, deleted_at desc) where deleted_at is not null;

alter table public.notes enable row level security;

create policy "notes_owner" on public.notes
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ------------------------------------------------------------
-- folders
-- ------------------------------------------------------------
create table public.folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  color text,
  icon text,
  deleted_at timestamptz,
  sort_order bigint not null default 0
);

create index folders_user_id_idx on public.folders(user_id);
-- см. комментарий у notes выше — тот же партиальный паттерн
create index folders_active_sort_idx on public.folders(user_id, sort_order) where deleted_at is null;
create index folders_trashed_deleted_idx on public.folders(user_id, deleted_at desc) where deleted_at is not null;

alter table public.folders enable row level security;

create policy "folders_owner" on public.folders
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ------------------------------------------------------------
-- note_folder_links (заметка ↔ папка, многие-ко-многим)
-- ------------------------------------------------------------
create table public.note_folder_links (
  note_id uuid not null references public.notes(id) on delete cascade,
  folder_id uuid not null references public.folders(id) on delete cascade,
  primary key (note_id, folder_id)
);

create index note_folder_links_folder_id_idx on public.note_folder_links(folder_id);

alter table public.note_folder_links enable row level security;

create policy "note_folder_links_owner" on public.note_folder_links
  for all to authenticated
  using (
    exists (select 1 from public.notes n where n.id = note_id and n.user_id = auth.uid())
    and exists (select 1 from public.folders f where f.id = folder_id and f.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.notes n where n.id = note_id and n.user_id = auth.uid())
    and exists (select 1 from public.folders f where f.id = folder_id and f.user_id = auth.uid())
  );

-- ------------------------------------------------------------
-- folder_folder_links (вложенность папок, многие-ко-многим)
-- ------------------------------------------------------------
create table public.folder_folder_links (
  parent_folder_id uuid not null references public.folders(id) on delete cascade,
  child_folder_id uuid not null references public.folders(id) on delete cascade,
  primary key (parent_folder_id, child_folder_id),
  check (parent_folder_id <> child_folder_id)
);

create index folder_folder_links_child_id_idx on public.folder_folder_links(child_folder_id);

alter table public.folder_folder_links enable row level security;

create policy "folder_folder_links_owner" on public.folder_folder_links
  for all to authenticated
  using (
    exists (select 1 from public.folders p where p.id = parent_folder_id and p.user_id = auth.uid())
    and exists (select 1 from public.folders c where c.id = child_folder_id and c.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.folders p where p.id = parent_folder_id and p.user_id = auth.uid())
    and exists (select 1 from public.folders c where c.id = child_folder_id and c.user_id = auth.uid())
  );

-- ------------------------------------------------------------
-- tags (справочник тегов для блоков текста)
-- ------------------------------------------------------------
create table public.tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  display_name text not null,
  color text,
  unique (user_id, name)
);

create index tags_user_id_idx on public.tags(user_id);

alter table public.tags enable row level security;

create policy "tags_owner" on public.tags
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ------------------------------------------------------------
-- blocks (помеченный диапазон внутри content заметки)
-- ------------------------------------------------------------
-- Производный индекс: полностью сносится и пересоздаётся из content заметки
-- при каждом сохранении (см. syncBlocksForNote в src/data/supabaseAdapter.js).
-- block_key — клиентский строковый id блока ("b1"), уникален только внутри
-- одной заметки; числового смещения (position) в модели нет нигде — блок
-- адресуется диапазоном строк через data-block-id, не offset'ом.
create table public.blocks (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes(id) on delete cascade,
  block_key text not null,
  html text not null,
  preview_text text not null,
  created_at timestamptz not null default now(),
  unique (note_id, block_key)
);

create index blocks_note_id_idx on public.blocks(note_id);

alter table public.blocks enable row level security;

create policy "blocks_owner" on public.blocks
  for all to authenticated
  using (exists (select 1 from public.notes n where n.id = note_id and n.user_id = auth.uid()))
  with check (exists (select 1 from public.notes n where n.id = note_id and n.user_id = auth.uid()));

-- ------------------------------------------------------------
-- block_tags (блок ↔ тег, многие-ко-многим)
-- ------------------------------------------------------------
create table public.block_tags (
  block_id uuid not null references public.blocks(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  primary key (block_id, tag_id)
);

create index block_tags_tag_id_idx on public.block_tags(tag_id);

alter table public.block_tags enable row level security;

create policy "block_tags_owner" on public.block_tags
  for all to authenticated
  using (
    exists (
      select 1 from public.blocks b
      join public.notes n on n.id = b.note_id
      where b.id = block_id and n.user_id = auth.uid()
    )
    and exists (select 1 from public.tags t where t.id = tag_id and t.user_id = auth.uid())
  )
  with check (
    exists (
      select 1 from public.blocks b
      join public.notes n on n.id = b.note_id
      where b.id = block_id and n.user_id = auth.uid()
    )
    and exists (select 1 from public.tags t where t.id = tag_id and t.user_id = auth.uid())
  );

-- ------------------------------------------------------------
-- favorites (избранное — заметка или папка целиком)
-- ------------------------------------------------------------
create table public.favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_type text not null check (item_type in ('note', 'folder')),
  item_id uuid not null,
  unique (user_id, item_type, item_id)
);

create index favorites_user_id_idx on public.favorites(user_id);

alter table public.favorites enable row level security;

create policy "favorites_owner" on public.favorites
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ------------------------------------------------------------
-- pins (закреплённое — заметка или папка, отдельно в каждом разделе)
-- ------------------------------------------------------------
create table public.pins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_type text not null check (item_type in ('note', 'folder')),
  item_id uuid not null,
  section_context text not null default 'global',
  unique (user_id, item_type, item_id, section_context)
);

create index pins_user_id_idx on public.pins(user_id);

alter table public.pins enable row level security;

create policy "pins_owner" on public.pins
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ------------------------------------------------------------
-- images (изображения на заметке)
-- ------------------------------------------------------------
create table public.images (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes(id) on delete cascade,
  storage_path text not null,
  position_x_percent numeric not null default 0,
  position_y_percent numeric not null default 0,
  width_percent numeric not null default 100,
  z_index integer not null default 0,
  title text,
  anchor_line_id text
);

create index images_note_id_idx on public.images(note_id);

alter table public.images enable row level security;

create policy "images_owner" on public.images
  for all to authenticated
  using (exists (select 1 from public.notes n where n.id = note_id and n.user_id = auth.uid()))
  with check (exists (select 1 from public.notes n where n.id = note_id and n.user_id = auth.uid()));

-- ------------------------------------------------------------
-- drawings (рисунки на заметке)
-- ------------------------------------------------------------
create table public.drawings (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes(id) on delete cascade,
  path_data text not null,
  position_x_percent numeric not null default 0,
  position_y_percent numeric not null default 0,
  z_index integer not null default 0,
  anchor_line_id text
);

create index drawings_note_id_idx on public.drawings(note_id);

alter table public.drawings enable row level security;

create policy "drawings_owner" on public.drawings
  for all to authenticated
  using (exists (select 1 from public.notes n where n.id = note_id and n.user_id = auth.uid()))
  with check (exists (select 1 from public.notes n where n.id = note_id and n.user_id = auth.uid()));

-- ------------------------------------------------------------
-- Права на таблицы для роли authenticated. RLS-политики выше решают, КАКИЕ
-- строки видно — но сама роль ещё должна иметь право прикоснуться к таблице,
-- иначе Postgres отвечает "permission denied for table ..." до всякой RLS.
-- anon НЕ грантуем — гость вообще не обращается к Supabase.
-- ------------------------------------------------------------
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.notes,
  public.folders,
  public.note_folder_links,
  public.folder_folder_links,
  public.tags,
  public.blocks,
  public.block_tags,
  public.favorites,
  public.pins,
  public.images,
  public.drawings
to authenticated;
