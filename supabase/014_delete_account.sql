-- ============================================================
-- myproj — миграция 014: пользователь может удалить свой аккаунт
--
-- Куда вставлять: Supabase Dashboard → "SQL Editor" → "New query" →
-- вставить весь файл целиком → Run. Требует миграции 001–013.
--
-- Зачем. Удалить запись в auth.users клиент не может (и не должен — у
-- него нет таких прав). Функция security definer выполняется от имени
-- владельца базы, но удаляет ровно того, кто её вызвал (auth.uid()), —
-- чужой аккаунт через неё не удалить. Нужна и для App Store: Apple требует
-- удаление аккаунта внутри приложения.
--
-- Фото в Storage (bucket note-images) функция НЕ трогает: Supabase не даёт
-- удалять файлы SQL-запросом к storage.objects. Их сайт и телефон удаляют
-- сами через Storage API — до вызова этой функции.
--
-- Почему не просто "delete from auth.users". Все таблицы и так удаляются
-- каскадом вместе с пользователем, но триггеры журнала из миграции 012 на
-- каждое удалённое в каскаде пишут строку в sync_changes со ссылкой на
-- пользователя — которого в этот момент уже нет. Такая строка нарушает
-- внешний ключ, и всё удаление падает. Поэтому сначала удаляем данные, пока
-- пользователь ещё есть, потом журнал, и только потом сам аккаунт.
-- ============================================================


create function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  -- Связи и флаги — до заметок и папок, чтобы их триггеры не дёргали
  -- уже удалённых владельцев
  delete from public.home_circles where user_id = uid;
  delete from public.favorites where user_id = uid;
  delete from public.pins where user_id = uid;
  -- Заметки уносят каскадом связи с папками, блоки, фото и рисунки
  delete from public.notes where user_id = uid;
  delete from public.folders where user_id = uid;
  delete from public.tags where user_id = uid;
  -- Всё, что выше успели записать триггеры, — тоже
  delete from public.sync_changes where user_id = uid;

  delete from auth.users where id = uid;
end
$$;

-- Вызывать может только вошедший; гостю и анониму функция недоступна
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
