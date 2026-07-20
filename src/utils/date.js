export function toISODate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function todayISO() {
  return toISODate(new Date());
}

/** Сетка из 42 дней (6 недель, Пн-старт), включая хвосты соседних месяцев. */
export function getMonthMatrix(year, month) {
  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7; // приводим Вс(0) -> 6, Пн(1) -> 0
  const gridStart = new Date(year, month, 1 - startOffset);

  const days = [];
  for (let i = 0; i < 42; i++) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + i);
    days.push({
      date,
      iso: toISODate(date),
      inCurrentMonth: date.getMonth() === month,
    });
  }
  return days;
}
