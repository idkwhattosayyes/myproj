// Единая точка обработки Esc. Всё, что визуально "лежит поверх" страницы
// (контекстное меню, модалка, поповер, панель настроек), регистрирует здесь
// свой обработчик закрытия. Esc закрывает верхний слой — по одному за нажатие.
const layers = [];

/**
 * @param {() => void} close вызывается, когда Esc доходит до этого слоя
 * @returns {() => void} снять регистрацию (вызывать при закрытии слоя любым другим способом)
 */
export function pushLayer(close) {
  const layer = { close };
  layers.push(layer);
  return () => {
    const index = layers.indexOf(layer);
    if (index !== -1) layers.splice(index, 1);
  };
}

/** @returns {boolean} был ли закрыт слой (false — открытых слоёв нет) */
export function closeTopLayer() {
  const layer = layers.pop();
  if (!layer) return false;
  layer.close();
  return true;
}

// Обработчик "шаг назад" текущего раздела: календарь уводит день -> месяц ->
// месяцы -> главная, остальные разделы — сразу на главную. Сбрасывается роутером
// перед каждым рендером, чтобы обработчик от прошлого раздела не пережил переход.
let viewEscape = null;

export function setViewEscape(handler) {
  viewEscape = handler;
}

export function getViewEscape() {
  return viewEscape;
}
