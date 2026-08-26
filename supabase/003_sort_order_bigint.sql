-- ============================================================
-- myproj — миграция 003: sort_order → bigint
--
-- Куда вставлять: Supabase Dashboard → "SQL Editor" → "New query" →
-- вставить весь файл целиком → Run.
--
-- Ошибка при первом же создании папки: "value ... is out of range for
-- type integer". order в JS-модели — Date.now() (13 цифр, миллисекунды),
-- а integer в Postgres вмещает максимум ~2.1 млрд — 002_notes_folders_
-- columns.sql завёл sort_order как integer по ошибке. bigint вмещает
-- Date.now() с огромным запасом.
-- ============================================================

alter table public.notes alter column sort_order type bigint;
alter table public.folders alter column sort_order type bigint;
