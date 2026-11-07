-- ============================================================
-- myproj — миграция 015: удалить аккаунт можно только с кодом из письма
--
-- Куда вставлять: Supabase Dashboard → "SQL Editor" → "New query" →
-- вставить весь файл целиком → Run. Требует миграции 014.
--
-- Зачем. Сайт и телефон перед удалением просят код из письма (шаблон
-- «Magic Link»). Но проверка только в приложении — это просьба, а не
-- запрет: тот, кто сидит в чужом открытом аккаунте и умеет программировать,
-- вызвал бы delete_my_account() в обход формы. Теперь функцию проверяет
-- сам сервер.
--
-- Как. Supabase записывает в токен вошедшего (auth.jwt() → "amr"), какими
-- способами и когда человек подтверждал себя: [{"method": "password",
-- "timestamp": ...}, {"method": "otp", ...}]. Код из письма — это "otp"
-- (или "magiclink" / "recovery" — смотря каким письмом). Удаляем, только
-- если такое подтверждение было за последние 10 минут.
--
-- Всё остальное — как в 014, без изменений.
-- ============================================================


create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  confirmed_by_code boolean;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select exists (
    select 1
    from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) as entry
    where entry ->> 'method' in ('otp', 'magiclink', 'recovery')
      and (entry ->> 'timestamp')::bigint > extract(epoch from now())::bigint - 600
  ) into confirmed_by_code;

  if not confirmed_by_code then
    raise exception 'email code required: confirm the deletion with the code from the email';
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

-- Права те же, что в 014: только вошедший
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
