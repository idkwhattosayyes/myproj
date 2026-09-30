/**
 * Отдать пользователю файл.
 *
 * Единственный способ, доступный без сервера: временная ссылка на Blob, клик по
 * ней и уборка за собой. Ссылку обязательно отзывать — иначе Blob висит в
 * памяти вкладки до её закрытия, а у заметки с фото это мегабайты.
 *
 * Живёт в utils, а не рядом с экспортом настроек, потому что выгрузок в проекте
 * теперь две: весь архив данных (settings/dataTransfer.js) и одна заметка
 * (modules/shared/noteExport.js).
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** То же самое для готовой строки: текст, разметка, что угодно. */
export function downloadText(text, filename, mime) {
  downloadBlob(new Blob([text], { type: mime }), filename);
}
