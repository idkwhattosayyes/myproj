// Чистые функции про вложенность папок (parentFolderIds — массив, папка может
// быть вложена сразу в несколько родителей). Общие для itemsService.js
// (серверная проверка перед сохранением) и panelSection.js (та же проверка
// локально, до оптимистичной отрисовки — см. localMoveFolderInto) — обе
// стороны обязаны видеть одну и ту же логику, а не две копии, которые могут
// разъехаться при следующей правке.

// Папки, созданные до появления вложенности, ещё не имеют parentFolderIds в
// хранилище — везде, где это поле читаем, подстраховываемся пустым массивом
// (тот же приём, что и у item.pinnedIn).
export function parentIdsOf(folder) {
  return folder.parentFolderIds || [];
}

// Обходит ВСЕ пути вверх по parentFolderIds (родителей может быть несколько) —
// true, если candidateAncestorId встречается среди предков startId.
export function isAncestorOf(folders, candidateAncestorId, startId) {
  const visited = new Set();
  const stack = [startId];
  while (stack.length) {
    const currentId = stack.pop();
    if (currentId === candidateAncestorId) return true;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const node = folders.find((f) => f.id === currentId);
    if (!node) continue;
    for (const parentId of parentIdsOf(node)) stack.push(parentId);
  }
  return false;
}
