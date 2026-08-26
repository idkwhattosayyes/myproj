-- ============================================================
-- myproj — миграция 005: приватный Storage bucket для фото заметок
-- (Этап 3, Модуль 4/5)
--
-- Куда вставлять: Supabase Dashboard → "SQL Editor" → "New query" →
-- вставить весь файл целиком → Run. Отдельных шагов в Dashboard-UI
-- (создание bucket руками, настройка политик кликами) не требуется —
-- всё выражается через SQL: insert into storage.buckets заводит
-- bucket ровно как кнопка "New bucket" в Storage UI, а политики на
-- storage.objects — обычные RLS-политики системной таблицы.
--
-- storage.objects — системная таблица Supabase, RLS на ней уже
-- включена по умолчанию для всех бакетов; отдельный
-- "alter table storage.objects enable row level security" не нужен
-- и может не сработать без повышенных прав.
--
-- Путь к файлу: "{userId}/{noteId}/{imageId}.{ext}" — не
-- "{userId}/{imageId}.jpg", как в буквальном примере ТЗ: второй
-- сегмент (noteId) даёт тривиальный bulk-delete всех фото заметки по
-- префиксу при permanent delete (см. deleteItem в
-- src/data/supabaseAdapter.js) без похода в БД за списком путей.
-- Владение по-прежнему проверяется только по ПЕРВОМУ сегменту
-- (userId) — так и задумано, это единственное, что должно быть
-- закреплено RLS-политикой.
--
-- storage.foldername(name) — встроенная функция Supabase Storage,
-- разбивает путь объекта на сегменты папок (без имени файла);
-- [1] — первый сегмент, тот же userId, что и auth.uid().
-- ============================================================

insert into storage.buckets (id, name, public)
values ('note-images', 'note-images', false)
on conflict (id) do nothing;

create policy "note_images_owner_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'note-images' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "note_images_owner_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'note-images' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "note_images_owner_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'note-images' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'note-images' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "note_images_owner_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'note-images' and (storage.foldername(name))[1] = auth.uid()::text);
