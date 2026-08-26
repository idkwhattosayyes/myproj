-- ============================================================
-- myproj — миграция 002: колонки для CRUD заметок/папок
--
-- Куда вставлять: Supabase Dashboard → "SQL Editor" → "New query" →
-- вставить весь файл целиком → Run. Применяется ОДИН РАЗ поверх уже
-- созданной схемы (schema.sql уже выполнен на этапе 1) — сам
-- schema.sql заново запускать не нужно, он теперь просто описывает
-- итоговую схему (создал бы ошибку "table already exists").
--
-- Добавляет sort_order (drag-and-drop) и activity_at (момент правки
-- текста/заголовка — для сортировки "недавно изменённые") к notes/folders.
-- Также убирает триггер автообновления updated_at из schema.sql: он бы
-- трогал updated_at при ЛЮБОМ обновлении, включая точечную запись
-- sort_order при перетаскивании — а это не должно считаться правкой
-- (так же ведёт себя нынешний localStorage-адаптер). Теперь updated_at
-- выставляет сам адаптер (src/data/supabaseAdapter.js), явно и только
-- когда это уместно.
--
-- И самое важное — выдаёт роли authenticated права на все 11 таблиц.
-- В schema.sql (этап 1) их не было: RLS-политики решают, какие СТРОКИ
-- видно, но без GRANT сама таблица недоступна вообще — Postgres отвечает
-- "permission denied for table notes" ещё до проверки RLS. Без этого блока
-- ни один запрос из supabaseAdapter.js работать не будет.
-- ============================================================

drop trigger if exists notes_set_updated_at on public.notes;
drop function if exists public.set_updated_at();

alter table public.notes
  add column if not exists sort_order bigint not null default 0,
  add column if not exists activity_at timestamptz not null default now();

alter table public.folders
  add column if not exists sort_order bigint not null default 0;

create index if not exists notes_sort_order_idx on public.notes(user_id, sort_order);
create index if not exists folders_sort_order_idx on public.folders(user_id, sort_order);

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
