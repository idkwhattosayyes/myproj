-- ============================================================
-- myproj — миграция 007: home_circles (кастомные кружки-ярлыки на главном)
--
-- Куда вставлять: Supabase Dashboard → "SQL Editor" → "New query" →
-- вставить весь файл целиком → Run.
--
-- Кастомные кружки-ярлыки на главном экране (src/modules/home/customCircles.js)
-- раньше хранились только в localStorage, в обход storageAdapter.js — при
-- входе с нового устройства/после очистки кэша браузера пропадали. Эта
-- таблица переносит их для залогиненных пользователей, вслед за
-- notes/folders/tags. pencilDismissed (флаг "видел ли онбординг") сюда не
-- входит — остаётся мелкой локальной UI-настройкой устройства, как
-- app:lastDrawColor, синхронизировать её незачем.
--
-- angle/radius — полярные координаты положения кружка относительно центра
-- .home-circles (см. circleLayout.js) — то, что в остальных таблицах играет
-- роль "порядка", здесь не список-порядок, а буквально позиция на экране;
-- отдельной колонки sort_order/position поэтому нет.
--
-- folder_id — контекст "из какой папки взяли эту заметку" для навигации по
-- клику (setPendingTarget в homeView.js), не участвует в модели
-- принадлежности заметки папке (та — note_folder_links, многие-ко-многим);
-- on delete set null — если папка удалена, кружок остаётся, просто теряет
-- контекст, а не исчезает целиком.
--
-- note_id ... on delete cascade — заметка удалена насовсем → кружок исчезает
-- сам. Заметка в Корзине (мягкое notes.deleted_at) каскад не трогает — там
-- по-прежнему решает клиентский pruneDeadCircles() (customCircles.js).
-- ============================================================

create table public.home_circles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  note_id uuid not null references public.notes(id) on delete cascade,
  folder_id uuid references public.folders(id) on delete set null,
  angle numeric not null,
  radius numeric not null,
  created_at timestamptz not null default now()
);

create index home_circles_user_id_idx on public.home_circles(user_id);
create index home_circles_note_id_idx on public.home_circles(note_id);

alter table public.home_circles enable row level security;

create policy "home_circles_owner" on public.home_circles
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.home_circles to authenticated;
