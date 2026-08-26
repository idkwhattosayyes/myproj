-- ============================================================
-- myproj — миграция 004: derived-индекс blocks/block_tags (Этап 3, Модуль 2/5)
--
-- Куда вставлять: Supabase Dashboard → "SQL Editor" → "New query" →
-- вставить весь файл целиком → Run.
--
-- blocks.start_position/end_position (schema.sql, этап 1) описывали модель
-- "числовое смещение внутри content", которой в коде никогда не было и не
-- будет: блок — диапазон строк, адресуемый строковым data-block-id ("b1",
-- "b2", ...), уникальным только внутри одной заметки (см.
-- ensureBlockIdFactory в src/modules/shared/blockTags.js). Заменяем offset
-- на клиентский строковый block_key.
--
-- html/preview_text — снэпшот содержимого блока на момент последней
-- синхронизации (см. syncBlocksForNote в src/data/supabaseAdapter.js) —
-- нужен полноэкранному браузеру тегов, чтобы показать карточку блока без
-- похода за content всей заметки и повторного парсинга.
--
-- Обе таблицы (blocks, block_tags) — производный индекс: полностью
-- снос-и-пересоздаются при каждом сохранении content заметки (или при
-- создании заметки/импорте с уже протегированным content), backfill не
-- нужен — таблицы сейчас пустые (модуль 2/5 ещё не сдан).
--
-- DROP COLUMN сам убирает check(end_position >= start_position): это
-- безымянный table-constraint этой же таблицы (не вид и не чужой FK),
-- CASCADE для него не требуется.
-- ============================================================

alter table public.blocks
  drop column start_position,
  drop column end_position,
  add column block_key text not null,
  add column html text not null,
  add column preview_text text not null,
  add constraint blocks_note_id_block_key_key unique (note_id, block_key);
