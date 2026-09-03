-- ============================================================
-- myproj — миграция 009: home_circles.angle/radius → nullable (правка 007)
--
-- Куда вставлять: Supabase Dashboard → "SQL Editor" → "New query" →
-- вставить весь файл целиком → Run.
--
-- Вторая ошибка проектирования в 007: angle/radius сделали not null,
-- решив, что позиция всегда известна на момент создания кружка. На деле
-- addCircle (customCircles.js) создаёт кружок БЕЗ позиции — её вычисляет
-- circleLayout.findPosition только при следующей отрисовке главной
-- (positionExtraCircles в homeView.js), и лишь тогда пишет её отдельным
-- вызовом updatePositions(). Отсюда and "null value in column angle
-- violates not-null constraint" при любом добавлении кружка через реальный
-- UI (кнопка "+"/карандаш) — angle/radius туда и не передавались никогда.
--
-- data.angle != null (JS, positionExtraCircles) одинаково истинно и для
-- undefined (как было в localStorage — просто отсутствующий ключ), и для
-- null (как теперь отдаёт Postgres) — downstream-код менять не нужно.
-- ============================================================

alter table public.home_circles alter column angle drop not null;
alter table public.home_circles alter column radius drop not null;
