-- ============================================================
-- myproj — миграция 012: журнал изменений для синхронизации телефона
--
-- Куда вставлять: Supabase Dashboard → "SQL Editor" → "New query" →
-- вставить весь файл целиком → Run. Требует миграции 001–011.
--
-- Сайт этой миграции не замечает: он не читает новые колонки и таблицу,
-- а триггеры только дописывают служебные строки. Порядок выкладки любой.
--
-- Зачем. Приложение на телефоне работает со своей копией данных (SQLite) —
-- и без сети тоже. Чтобы догнать сервер, ему нужно спросить «что поменялось
-- с прошлого раза?», а Postgres сам этого не помнит:
--   - удалённая насовсем заметка просто исчезает — телефон не узнал бы, что
--     её надо убрать и у себя;
--   - папки, избранное и закрепления живут в отдельных таблицах, и их правка
--     не трогает строку заметки.
-- Поэтому:
--   1. sync_changes — журнал: какая заметка/папка/тег/кружок изменились или
--      удалены и когда. Пишут его триггеры, сами, при любой записи — с сайта
--      или с телефона. Телефон читает журнал «после момента X» и докачивает
--      только изменившееся.
--   2. sync_version у заметок и папок — номер версии строки, растёт на
--      каждой правке (в том числе папок/избранного/закрепления заметки).
--      Телефон отправляет правку с условием «если версия всё ещё N»: не
--      совпала — значит, заметку успели поменять на сайте, и телефон сначала
--      склеит обе правки, а не затрёт чужую.
-- ============================================================


-- ---------- 1. Номер версии у заметок и папок ----------

alter table public.notes add column sync_version bigint not null default 1;
alter table public.folders add column sync_version bigint not null default 1;

-- Любое обновление строки поднимает версию. Если клиент сам прислал
-- sync_version (телефон), всё равно ставим old + 1: версию ведёт сервер
create function public.bump_sync_version()
returns trigger
language plpgsql
as $$
begin
  new.sync_version := old.sync_version + 1;
  return new;
end
$$;

create trigger notes_bump_sync_version
  before update on public.notes
  for each row execute function public.bump_sync_version();

create trigger folders_bump_sync_version
  before update on public.folders
  for each row execute function public.bump_sync_version();


-- ---------- 2. Журнал изменений ----------

-- entity — что изменилось: 'note' | 'folder' | 'tag' | 'home_circle'.
-- deleted — строку удалили насовсем (корзина — это не удаление, а правка
-- deleted_at). id по порядку: телефон помнит последний прочитанный.
create table public.sync_changes (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  entity text not null check (entity in ('note', 'folder', 'tag', 'home_circle')),
  entity_id uuid not null,
  deleted boolean not null default false,
  changed_at timestamptz not null default clock_timestamp()
);

create index sync_changes_user_id_idx on public.sync_changes(user_id, id);

alter table public.sync_changes enable row level security;

-- Читать — только свои строки. Писать напрямую нельзя никому: строки
-- добавляют только триггеры ниже (security definer — от имени владельца базы)
create policy "sync_changes_owner_read" on public.sync_changes
  for select to authenticated
  using (auth.uid() = user_id);

grant select on public.sync_changes to authenticated;

create function public.log_sync_change(p_user_id uuid, p_entity text, p_entity_id uuid, p_deleted boolean)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.sync_changes (user_id, entity, entity_id, deleted)
  select p_user_id, p_entity, p_entity_id, p_deleted
  where p_user_id is not null;
$$;

-- Таблицы со своим user_id: notes, folders, tags, home_circles
create function public.log_owned_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  entity text := tg_argv[0];
begin
  if tg_op = 'DELETE' then
    perform public.log_sync_change(old.user_id, entity, old.id, true);
    return old;
  end if;
  perform public.log_sync_change(new.user_id, entity, new.id, false);
  return new;
end
$$;

create trigger notes_log_sync after insert or update or delete on public.notes
  for each row execute function public.log_owned_row_change('note');
create trigger folders_log_sync after insert or update or delete on public.folders
  for each row execute function public.log_owned_row_change('folder');
create trigger tags_log_sync after insert or update or delete on public.tags
  for each row execute function public.log_owned_row_change('tag');
create trigger home_circles_log_sync after insert or update or delete on public.home_circles
  for each row execute function public.log_owned_row_change('home_circle');


-- ---------- 3. Связи: меняют «свою» заметку или папку ----------
-- Папка заметки, избранное, закрепление — это часть заметки (или папки) для
-- телефона. Правка такой связи поднимает версию владельца и пишет в журнал
-- изменение владельца. Если владелец сам удаляется (каскад), строки уже нет —
-- update ничего не найдёт, а его удаление и так записано в журнал.

-- «Пустой» update строки-владельца: сам ничего не меняет, но на нём
-- срабатывают триггеры выше — bump_sync_version поднимает версию, а
-- log_owned_row_change пишет изменение в журнал. Так у связи нет своей
-- логики журнала, всё идёт одной дорогой
create function public.touch_note(p_note_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.notes set sync_version = sync_version where id = p_note_id;
$$;

create function public.touch_folder(p_folder_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.folders set sync_version = sync_version where id = p_folder_id;
$$;

-- note_folder_links: меняет заметку (её список папок)
create function public.note_folder_links_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.touch_note(case when tg_op = 'DELETE' then old.note_id else new.note_id end);
  return null;
end
$$;

create trigger note_folder_links_sync after insert or update or delete on public.note_folder_links
  for each row execute function public.note_folder_links_touch();

-- folder_folder_links: меняет вложенную папку (её список родителей)
create function public.folder_folder_links_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.touch_folder(case when tg_op = 'DELETE' then old.child_folder_id else new.child_folder_id end);
  return null;
end
$$;

create trigger folder_folder_links_sync after insert or update or delete on public.folder_folder_links
  for each row execute function public.folder_folder_links_touch();

-- favorites и pins: item_type говорит, чья это строка
create function public.item_flag_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  kind text := case when tg_op = 'DELETE' then old.item_type else new.item_type end;
  target uuid := case when tg_op = 'DELETE' then old.item_id else new.item_id end;
begin
  if kind = 'note' then
    perform public.touch_note(target);
  else
    perform public.touch_folder(target);
  end if;
  return null;
end
$$;

create trigger favorites_sync after insert or update or delete on public.favorites
  for each row execute function public.item_flag_touch();
create trigger pins_sync after insert or update or delete on public.pins
  for each row execute function public.item_flag_touch();

-- Вызывать эти функции напрямую клиенту незачем — только триггерам
revoke execute on function
  public.log_sync_change(uuid, text, uuid, boolean),
  public.touch_note(uuid),
  public.touch_folder(uuid)
from public, anon, authenticated;


-- ---------- Как откатить, если что-то пошло не так ----------
-- Данные заметок миграция не меняет, поэтому откат безопасен:
--
-- drop trigger notes_bump_sync_version on public.notes;
-- drop trigger folders_bump_sync_version on public.folders;
-- drop trigger notes_log_sync on public.notes;
-- drop trigger folders_log_sync on public.folders;
-- drop trigger tags_log_sync on public.tags;
-- drop trigger home_circles_log_sync on public.home_circles;
-- drop trigger note_folder_links_sync on public.note_folder_links;
-- drop trigger folder_folder_links_sync on public.folder_folder_links;
-- drop trigger favorites_sync on public.favorites;
-- drop trigger pins_sync on public.pins;
-- drop function public.item_flag_touch(), public.folder_folder_links_touch(),
--   public.note_folder_links_touch(), public.touch_note(uuid), public.touch_folder(uuid),
--   public.log_owned_row_change(), public.log_sync_change(uuid, text, uuid, boolean),
--   public.bump_sync_version();
-- drop table public.sync_changes;
-- alter table public.notes drop column sync_version;
-- alter table public.folders drop column sync_version;
