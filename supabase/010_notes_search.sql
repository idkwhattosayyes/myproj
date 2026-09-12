-- ============================================================
-- myproj — миграция 010: серверный поиск по заметкам (pg_trgm + ILIKE)
--
-- Куда вставлять: Supabase Dashboard → "SQL Editor" → "New query" →
-- вставить весь файл целиком → Run.
--
-- До этой миграции поиск (src/search/searchService.js) на каждый запрос
-- скачивал content ВСЕХ заметок аккаунта — у владельца это 3.8 МБ, из них
-- 3.5 МБ одна заметка с фото в base64, при 82 КБ реального текста на все
-- заметки. Отсюда 2–5 секунд до результатов.
--
-- Теперь кандидатов отбирает сервер. У notes появляются две служебные
-- колонки, которые Postgres сам пересчитывает при каждой правке
-- title/content (generated … stored):
--   search_text — заголовок и текст заметки без HTML, строки редактора
--                 через перевод строки;
--   photo_names — названия фото в порядке документа.
-- По search_text — триграммный GIN-индекс, поиск идёт ILIKE '%запрос%'.
-- Семантика та же, что у клиентского indexOf — подстрока без учёта
-- регистра, — поэтому pg_trgm, а не tsvector: тот ищет по словам и не даёт
-- «порядковый номер вхождения», на который завязан переход к найденному
-- месту в редакторе (findOccurrenceRange в richTextEditor.js).
--
-- RPC search_notes отдаёт клиенту уже очищенный текст и список фото —
-- сниппеты и номера вхождений клиент считает сам, а content поиску больше
-- не нужен вовсе: base64-заметка перестаёт участвовать в трафике.
-- ============================================================

-- Триграммы для индексации LIKE/ILIKE. Supabase кладёт расширения в схему
-- extensions (так же делает Dashboard → Database → Extensions). Если pg_trgm
-- уже включён в другой схеме, ниже в индексе убрать префикс "extensions.".
create extension if not exists pg_trgm with schema extensions;

-- Текст заметки для поиска. Шаги ЗЕРКАЛЯТ htmlToSearchText в
-- src/utils/dom.js — один в один и в том же порядке: гость получает этот
-- текст от браузера, залогиненный — отсюда, и оба обязаны совпадать, иначе
-- сервер найдёт заметку, а клиент в её тексте — нет (или наоборот).
-- Меняешь регулярку или порядок здесь — меняй и там.
--
-- immutable — условие Postgres для генерируемой колонки: результат зависит
-- только от аргументов, что здесь и так верно. plpgsql, а не одно вложенное
-- выражение — чтобы каждый шаг читался отдельной строкой.
create function public.note_search_text(title text, content text)
returns text
language plpgsql
immutable
as $$
declare
  t text := content;
  -- Метка пустой строки: управляющий символ U+0001, в тексте заметки его
  -- не бывает. Метка, а не сразу два перевода строки: ниже серии "\n"
  -- схлопываются в один, и без метки пустая строка была бы неотличима от
  -- границы вложенных тегов.
  empty_line constant text := chr(1);
begin
  -- 1. Инлайн-теги (жирный, цвет, ссылка, заголовок-в-строке…) → пусто:
  --    «hel<b>lo</b>» — это слово «hello». Первым шагом — чтобы пустая строка
  --    вида <div><b><br></b></div> дальше выглядела как обычная пустая.
  t := regexp_replace(t, '</?(?:a|b|i|u|s|em|strong|span|font|mark|sub|sup|code)(?:\s[^>]*)?>', '', 'gi');
  -- 2. Пустая строка редактора — элемент строки, в котором нет ничего, кроме
  --    <br>, пробелов и &nbsp; → метка. <hr> (разделитель) — тоже разрыв абзаца.
  t := regexp_replace(t, '<(div|p|li|h[1-6])(?:\s[^>]*)?>(?:\s|&nbsp;|<br[^>]*>)*</\1>', empty_line, 'gi');
  t := regexp_replace(t, '<hr[^>]*>', empty_line, 'gi');
  -- 3. Концы строк редактора, <br> и начало списка/таблицы → перевод строки.
  t := regexp_replace(t, '</(?:div|p|li|h[1-6]|tr)>|<br[^>]*>|<(?:ul|ol|table)(?:\s[^>]*)?>', E'\n', 'gi');
  -- 4. Остальные теги → пробел (<img> с base64 в src и <svg> уходят целиком).
  t := regexp_replace(t, '<[^>]*>', ' ', 'g');
  -- 5. Сущности. В браузере их раскрывает парсер; здесь — самые ходовые,
  --    &amp; последним, иначе «&amp;lt;» раскрылся бы дважды.
  t := replace(t, '&nbsp;', ' ');
  t := replace(t, '&quot;', '"');
  t := replace(t, '&#39;', '''');
  t := replace(t, '&lt;', '<');
  t := replace(t, '&gt;', '>');
  t := replace(t, '&amp;', '&');
  -- 6. Пробелы внутри строки — в один; серии переводов строки с пробелами
  --    между — в один; метка → перевод строки (вместе с соседним даёт два
  --    подряд — пустую строку); пробелы вокруг переводов и по краям — убрать.
  t := regexp_replace(t, E'[ \t\r]+', ' ', 'g');
  t := regexp_replace(t, E'[ \n]*\n[ \n]*', E'\n', 'g');
  t := replace(t, empty_line, E'\n');
  t := regexp_replace(t, E' *\n *', E'\n', 'g');
  return title || E'\n' || btrim(t, E' \n');
end
$$;

-- Названия фото (img.rte-photo) в порядке документа; у безымянного — пустая
-- строка. Индекс в массиве = photoIndex на клиенте (extractPhotos в
-- src/utils/dom.js): по нему результат поиска ведёт к конкретному фото.
create function public.note_photo_names(content text)
returns text[]
language sql
immutable
as $$
  select coalesce(array_agg(coalesce(substring(m[1] from 'data-name="([^"]*)"'), '') order by ord), '{}'::text[])
  from regexp_matches(content, '<img[^>]*>', 'g') with ordinality as t(m, ord)
  where m[1] ~ 'class="[^"]*\mrte-photo\M';
$$;

-- Колонки считает та роль, что пишет строку (authenticated) — ей нужно право
-- вызвать функции.
grant execute on function public.note_search_text(text, text), public.note_photo_names(text) to authenticated;

-- stored: значение лежит в строке (иначе индекс не построить); для уже
-- существующих заметок Postgres посчитает его прямо сейчас. Адаптер эти
-- колонки никогда не выбирает — см. NOTE_COLUMNS в supabaseAdapter.js.
alter table public.notes
  add column search_text text generated always as (public.note_search_text(title, content)) stored,
  add column photo_names text[] generated always as (public.note_photo_names(content)) stored;

-- Partial-индекс с тем же предикатом, что у search_notes ниже (и у
-- notes_active_sort_idx из 006): Корзина в поиске не участвует.
create index notes_search_text_trgm_idx
  on public.notes using gin (search_text extensions.gin_trgm_ops)
  where deleted_at is null;

-- security invoker: функция работает от имени вызвавшего (authenticated с
-- его auth.uid()), RLS notes_owner действует внутри неё как обычно — каждый
-- ищет только по своим заметкам.
--
-- Возвращает: body_text — search_text без первой строки (заголовка), чтобы
-- совпадение в названии не показывалось ещё и сниппетом; photo_names — для
-- совпадений по фото. Порядок: совпавшие названия первыми — клиент показывает
-- их выше, и при срезе max_rows отрезаться должны совпадения в тексте.
-- Запрос ровно «photo»/«фото» (any_photo) находит все заметки с фото — по
-- тому же признаку, что клиент (см. isGenericPhotoQuery в searchService.js).
create function public.search_notes(q text, any_photo boolean default false, max_rows int default 40)
returns table (id uuid, title text, sort_order bigint, body_text text, photo_names text[])
language sql
stable
security invoker
set search_path = public
as $$
  with p as (
    -- \ % _ — спецсимволы LIKE: экранируем, чтобы «50%» искало буквально
    -- «50%», а не «50 и что угодно дальше».
    select '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
  )
  select n.id, n.title, n.sort_order, substr(n.search_text, length(n.title) + 2), n.photo_names
  from public.notes n, p
  where n.deleted_at is null
    and (
      n.search_text ilike p.pat
      or exists (select 1 from unnest(n.photo_names) as name where name ilike p.pat)
      or (any_photo and cardinality(n.photo_names) > 0)
    )
  order by (n.title ilike p.pat) desc, n.sort_order
  limit max_rows;
$$;

-- anon к функции не подпускаем — как и к таблицам (см. schema.sql).
revoke execute on function public.search_notes(text, boolean, int) from public, anon;
grant execute on function public.search_notes(text, boolean, int) to authenticated;
