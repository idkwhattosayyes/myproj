import { getStorage } from "../data/storageAdapter.js";
import { appendCircles } from "../modules/home/customCircles.js";
import * as blockTagsService from "../services/blockTagsService.js";

// Экспорт/импорт заметок и папок одним JSON-файлом. Форматирование хранится
// прямо в item.content (HTML), поэтому выгрузка моделей сохраняет жирность,
// цвета, ссылки и вставленные фото как есть — импорт восстанавливает точь-в-точь.
//
// Версия 2 добавила к папкам и заметкам кружки главной и календарь. Версия 3 —
// глобальный реестр тегов блока (app:blockTags, сами блоки хранятся внутри
// content каждой заметки, см. remapBlockTags). Файлы более старых версий
// читаются по-прежнему: новых полей в них просто нет, и импорт их пропускает.
const EXPORT_VERSION = 3;

/**
 * Экспорт из выбранного набора (дерево с галочками). Набор папок/заметок приходит
 * уже согласованным: дерево добавляет папки-владельцев выбранных заметок само.
 * Кружки, календарь и теги блоков собирает вызывающий код — здесь только сборка
 * файла. blockTags — реестр целиком, как и calendar, в дереве выбора не участвует.
 */
export function buildExportFrom({ folders, items, homeCircles = [], calendar = null, blockTags = [] }) {
  return {
    app: "myproj",
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    scope: "custom",
    folders,
    items,
    homeCircles,
    calendar,
    blockTags,
  };
}

// Кружки главной ссылаются на заметку по id. Кружок на заметку, которую в выгрузку
// не включили, восстанавливать не на что — такие в файл не кладём.
export function circlesForItems(circles, items) {
  const exportedIds = new Set(items.map((item) => item.id));
  return circles.filter((circle) => exportedIds.has(circle.noteId));
}

export function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Открывает диалог выбора файла и возвращает разобранный JSON (или null, если
// пользователь ничего не выбрал). Бросает, если файл — не валидный JSON.
export function readJsonFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(JSON.parse(String(reader.result)));
        } catch {
          reject(new Error("bad-json"));
        }
      };
      reader.onerror = () => reject(new Error("read-failed"));
      reader.readAsText(file);
    });
    input.click();
  });
}

export function isValidExport(data) {
  return !!data && data.app === "myproj" && Array.isArray(data.items);
}

// Ссылка на другую заметку живёт в самом HTML заметки — <a data-item-id="...">
// (см. applyInternalLink в richTextEditor.js). При импорте заметки получают новые
// id, поэтому ссылку нужно переписать, иначе она указывает на id, которого в этой
// базе нет. Цель вне выгрузки оставляем как есть: файл могут импортировать туда,
// где та заметка существует, — там ссылка сработает, а где нет — редактор скажет
// «заметка не найдена».
//
// Разбираем через DOM, а не регуляркой: в content лежат фото и рисунки, и любая
// текстовая замена по разметке рискует зацепить их данные. Заметки без внутренних
// ссылок не трогаем вовсе — незачем гонять через парсер мегабайты base64.
function remapInternalLinks(content, itemIdMap) {
  if (!content || !content.includes("data-item-id")) return content || "";
  const holder = document.createElement("div");
  holder.innerHTML = content;
  holder.querySelectorAll("a[data-item-id]").forEach((link) => {
    const mapped = itemIdMap.get(link.dataset.itemId);
    if (mapped) link.dataset.itemId = mapped;
  });
  return holder.innerHTML;
}

// Тег блока хранится не в самой заметке, а в общем реестре app:blockTags —
// строка блока ссылается на него по id через data-tag-ids (JSON-массив, см.
// blockTags.js). При импорте реестр получает новые id, значит и в content
// заметки их нужно переписать — тот же приём, что remapInternalLinks, и по
// той же причине не трогать заметки без единого блока вовсе.
function remapBlockTags(content, blockTagIdMap) {
  if (!content || !content.includes("data-tag-ids")) return content || "";
  const holder = document.createElement("div");
  holder.innerHTML = content;
  holder.querySelectorAll("[data-tag-ids]").forEach((line) => {
    let ids;
    try {
      ids = JSON.parse(line.dataset.tagIds);
    } catch {
      return;
    }
    line.dataset.tagIds = JSON.stringify(ids.map((id) => blockTagIdMap.get(id)).filter(Boolean));
  });
  return holder.innerHTML;
}

// Имя (тега или заметки), которое уже занято — у пользователя или другой
// сущностью из этого же файла, — получает суффикс "(N)", растущий, пока не
// найдётся свободное имя. Сравнение без учёта регистра/краевых пробелов.
// Оригинальная сущность не трогается; дубликат создаётся отдельной записью со
// своим id — id-based ремап (blockTagIdMap/itemIdMap) ничего не знает об
// имени, поэтому переименование не требует отдельной правки remapBlockTags.
function uniqueName(name, takenKeys) {
  if (!takenKeys.has(name.trim().toLowerCase())) return name;
  let n = 1;
  while (takenKeys.has(`${name} (${n})`.trim().toLowerCase())) n++;
  return `${name} (${n})`;
}

// Кружки главной: заметку и папку-контекст переводим на новые id, кружок на
// невосстановленную заметку отбрасываем. Позицию переносим как есть — если
// импортированный кружок сядет поверх существующего, раскладка главной разведёт
// их сама (см. fitsAt/findPosition в homeView.js).
function importHomeCircles(circles, folderIdMap, itemIdMap) {
  const restored = (circles || [])
    .map((circle) => ({
      noteId: itemIdMap.get(circle.noteId),
      folderId: folderIdMap.get(circle.folderId) || null,
      angle: circle.angle,
      radius: circle.radius,
    }))
    .filter((circle) => circle.noteId);
  appendCircles(restored);
  return restored.length;
}

// Календарь идёт в файл целиком (в дереве выбора его нет). Записи ссылаются на тег
// по id, поэтому сначала теги — и запись получает уже новый tagId.
async function importCalendar(calendar) {
  const storage = getStorage();
  const tagIdMap = new Map();

  for (const tag of (calendar && calendar.tags) || []) {
    const newId = crypto.randomUUID();
    tagIdMap.set(tag.id, newId);
    await storage.createCalendarTag({ ...tag, id: newId });
  }

  const entries = (calendar && calendar.entries) || [];
  for (const entry of entries) {
    await storage.createCalendarEntry({
      ...entry,
      id: crypto.randomUUID(),
      tagId: entry.tagId ? tagIdMap.get(entry.tagId) || null : null,
    });
  }
  return entries.length;
}

// Создаёт новые записи, не затирая существующие. Старые id перемаппливаем на
// свежие — и папкам, и заметкам, — чтобы все связи указывали на вновь созданные
// записи, а не на возможно чужие/несуществующие. Поддерживаем и старый формат
// (folderId/pinned скаляры), и новый (folderIds/pinnedIn массивы).
export async function importData(data) {
  const storage = getStorage();
  const now = new Date().toISOString();

  // Новые id раздаём заранее, до единой записи: связь может смотреть и вперёд
  // (заметка ссылается на ту, что идёт ниже по файлу; папка вложена в папку,
  // объявленную позже), а на момент создания все id уже должны быть известны.
  const folderIdMap = new Map((data.folders || []).map((folder) => [folder.id, crypto.randomUUID()]));
  const itemIdMap = new Map(data.items.map((item) => [item.id, crypto.randomUUID()]));
  // Заранее, а не отложенно (как tagIdMap календаря) — нужна уже на шаге ремапа
  // content ниже, а не после того, как все заметки записаны.
  const blockTagIdMap = new Map((data.blockTags || []).map((tag) => [tag.id, crypto.randomUUID()]));
  // Снимаем занятые имена один раз и пополняем вручную по ходу цикла — иначе
  // коллизия МЕЖДУ двумя тегами одного файла (оба "DAILY") не будет замечена:
  // storage.getBlockTags() внутри цикла не перевызывается, а созданный на
  // предыдущей итерации тег виден только через этот Set.
  const takenNameKeys = new Set((await storage.getBlockTags()).map((tag) => tag.nameKey));
  for (const tag of data.blockTags || []) {
    const name = uniqueName(tag.name, takenNameKeys);
    const nameKey = name.trim().toLowerCase();
    takenNameKeys.add(nameKey);
    await storage.createBlockTag({ ...tag, id: blockTagIdMap.get(tag.id), name, nameKey });
  }
  // Та же логика для заголовков заметок — заметка с названием, которое уже
  // есть у пользователя (или у другой заметки этого же файла), получает
  // суффикс "(N)", чтобы её было видно отдельно от уже существующей.
  const takenTitleKeys = new Set((await storage.getItems("notes")).map((item) => item.title.trim().toLowerCase()));

  for (const folder of data.folders || []) {
    // Вложенность папки живёт в parentFolderIds (папка может лежать сразу в
    // нескольких). Раньше поле копировалось как есть — со ссылками на исчезнувшие
    // id, из-за чего вложенные папки после импорта всплывали на верхний уровень.
    const parentFolderIds = (folder.parentFolderIds || []).map((id) => folderIdMap.get(id)).filter(Boolean);
    await storage.createFolder({ ...folder, id: folderIdMap.get(folder.id), parentFolderIds });
  }

  for (const item of data.items) {
    const srcFolderIds = Array.isArray(item.folderIds) ? item.folderIds : item.folderId ? [item.folderId] : [];
    // Папки не из набора экспорта отбрасываем (folderIdMap.get вернёт undefined).
    const folderIds = srcFolderIds.map((id) => folderIdMap.get(id)).filter(Boolean);
    const srcPinnedIn = Array.isArray(item.pinnedIn) ? item.pinnedIn : item.pinned ? ["all"] : [];
    // Спец-ключи мест оставляем как есть, id папок ремапим (неизвестные отбрасываем).
    const pinnedIn = srcPinnedIn
      .map((key) => (key === "all" || key === "favorites" || key === "unfiled" ? key : folderIdMap.get(key)))
      .filter(Boolean);
    const content = remapBlockTags(remapInternalLinks(item.content, itemIdMap), blockTagIdMap);
    const newId = itemIdMap.get(item.id);
    const title = uniqueName(item.title || "", takenTitleKeys);
    takenTitleKeys.add(title.trim().toLowerCase());
    await storage.createItem({
      ...item,
      id: newId,
      title,
      content,
      folderIds,
      pinnedIn,
      createdAt: item.createdAt || now,
      updatedAt: now,
    });
    // storage.createItem вызван напрямую (не через itemsService), поэтому
    // централизованный хук синхронизации там до этой заметки не дотянется —
    // единственное место, где derived-индекс blocks/block_tags нужно подтолкнуть
    // явно (см. комментарий у syncBlocksIndex в blockTagsService.js).
    await blockTagsService.syncBlocksIndex(newId, content);
  }

  const circles = importHomeCircles(data.homeCircles, folderIdMap, itemIdMap);
  const calendarEntries = await importCalendar(data.calendar);

  return {
    folders: (data.folders || []).length,
    items: data.items.length,
    circles,
    calendarEntries,
    blockTags: (data.blockTags || []).length,
  };
}
