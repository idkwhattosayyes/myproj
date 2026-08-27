-- ============================================================
-- myproj — миграция 006: индексы под реальные запросы списков заметок/папок
-- (оптимизация скорости под аккаунтом)
--
-- Куда вставлять: Supabase Dashboard → "SQL Editor" → "New query" →
-- вставить весь файл целиком → Run.
--
-- supabaseAdapter.js фильтрует notes/folders по "deleted_at is null"
-- (активный список) или "deleted_at is not null" (Корзина) и сортирует —
-- под это нужен partial-индекс именно с таким предикатом; обычный
-- (user_id, sort_order) без предиката покрывает такой запрос хуже, особенно
-- по мере роста корзины.
--
-- notes_sort_order_idx/folders_sort_order_idx (schema.sql/002) после этой
-- миграции избыточны для реальных запросов адаптера — partial-версии их
-- полностью перекрывают, дропаем.
-- ============================================================

create index notes_active_sort_idx on public.notes(user_id, sort_order) where deleted_at is null;
create index notes_trashed_deleted_idx on public.notes(user_id, deleted_at desc) where deleted_at is not null;
create index folders_active_sort_idx on public.folders(user_id, sort_order) where deleted_at is null;
create index folders_trashed_deleted_idx on public.folders(user_id, deleted_at desc) where deleted_at is not null;

drop index if exists public.notes_sort_order_idx;
drop index if exists public.folders_sort_order_idx;
