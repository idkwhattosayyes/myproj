-- ============================================================
-- myproj — миграция 008: home_circles.folder_id → text (правка 007)
--
-- Куда вставлять: Supabase Dashboard → "SQL Editor" → "New query" →
-- вставить весь файл целиком → Run.
--
-- Ошибка проектирования в 007: folder_id завели как uuid с FK на
-- public.folders(id), решив, что это всегда id настоящей папки. На деле
-- circle.folderId — это то, что вернул note picker (src/modules/home/
-- notePicker.js), а он кроме настоящих id папок отдаёт ещё и псевдо-id
-- "all"/"favorites"/"unfiled" (выбор через одноимённые псевдо-папки) — их
-- же потом читает panelSection.js (PSEUDO_FOLDER_IDS) при переходе по клику
-- на кружок, чтобы открыть нужный раздел, а не только настоящую папку.
-- uuid-колонка с FK такие значения принять не может ("invalid input syntax
-- for type uuid") — INSERT с ними падал целиком.
--
-- Правильный тип — text без FK, ровно как это поле уже вело себя в
-- localStorage (просто непрозрачная строка, без проверки, что это id
-- реальной папки).
-- ============================================================

alter table public.home_circles drop constraint home_circles_folder_id_fkey;
alter table public.home_circles alter column folder_id type text using folder_id::text;
