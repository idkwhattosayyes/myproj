-- ============================================================
-- myproj — миграция 013: служебные колонки поиска считаются только
-- при правке текста
--
-- Куда вставлять: Supabase Dashboard → "SQL Editor" → "New query" →
-- вставить весь файл целиком → Run. Требует миграции 001–012.
--
-- Сайт и телефон этой миграции не замечают: колонки те же, значения те же.
--
-- Зачем. search_text, photo_names и body_empty были generated … stored, а
-- Postgres пересчитывает такие колонки при КАЖДОМ update строки — даже если
-- title и content не менялись. С миграцией 012 строку заметки трогает любая
-- правка её связей (папка, избранное, закрепление — см. touch_note), плюс
-- перетаскивание меняет sort_order. И каждый раз весь content заново
-- разбирается регулярками: на заметке в 3,6 МБ это около 0,5 с на одну
-- галочку «в избранное».
--
-- Поэтому колонки становятся обычными, а считает их триггер — и только
-- когда title или content действительно изменились. Формулы те же самые
-- (note_search_text / note_photo_names из 010, условие body_empty из 011).
-- ============================================================


-- ---------- 1. Колонки перестают быть generated ----------

-- drop expression оставляет в колонке уже посчитанные значения — они и так
-- верные, поэтому пересчитывать (и переписывать все строки) не нужно.
-- Это правка только описания таблицы: строки не трогаются, триггеры 012
-- не срабатывают, журнал sync_changes не засоряется.
alter table public.notes
  alter column search_text drop expression,
  alter column photo_names drop expression,
  alter column body_empty drop expression;


-- ---------- 2. Триггер, который их считает ----------

create function public.note_search_fields()
returns trigger
language plpgsql
as $$
begin
  -- Текст не менялся — оставляем старые значения. Сравнение двух строк
  -- дёшево, в отличие от разбора HTML. Заодно клиент не может подсунуть
  -- в эти колонки своё: раньше generated-колонку записать было нельзя
  -- вовсе, и так должно остаться
  if tg_op = 'UPDATE'
     and new.title is not distinct from old.title
     and new.content is not distinct from old.content then
    new.search_text := old.search_text;
    new.photo_names := old.photo_names;
    new.body_empty := old.body_empty;
    return new;
  end if;

  new.search_text := public.note_search_text(new.title, new.content);
  new.photo_names := public.note_photo_names(new.content);
  -- то же условие, что было в generated-колонке (011_notes_body_empty.sql)
  new.body_empty :=
    btrim(public.note_search_text('', coalesce(new.content, '')), E' \n') = ''
    and coalesce(new.content, '') !~* '<img\M'
    and coalesce(new.content, '') !~* '<path\M';
  return new;
end
$$;

create trigger notes_search_fields
  before insert or update on public.notes
  for each row execute function public.note_search_fields();


-- ---------- Как откатить, если что-то пошло не так ----------
-- Вернуть generated-колонки можно только пересозданием (Postgres не умеет
-- «add expression»), это перепишет все заметки и запишет их в журнал 012:
--
-- drop trigger notes_search_fields on public.notes;
-- drop function public.note_search_fields();
-- drop index public.notes_search_text_trgm_idx;
-- alter table public.notes drop column search_text, drop column photo_names, drop column body_empty;
-- затем блоки add column … generated из 010_notes_search.sql и
-- 011_notes_body_empty.sql и индекс notes_search_text_trgm_idx из 010.
