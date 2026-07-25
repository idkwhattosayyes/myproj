// Работа с изображениями для вставки в заметку. Фото хранится прямо в теле
// заметки как data:URL внутри <img>, а всё тело — это строка в localStorage.
// Поэтому крупные снимки обязательно ужимаем: несколько оригиналов с телефона
// переполнили бы общий лимит хранилища (~5 МБ на все данные) за пару вставок.

const MAX_PHOTO_SIZE = 1600;

// Файл (из <input type=file> или из буфера обмена) → data:URL.
export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Ужимает data:URL до maxSize по длинной стороне через <canvas>. Если картинка
// и так меньше — возвращаем исходный data:URL без перекодирования, чтобы зря не
// терять качество и не раздувать PNG-скриншоты в JPEG.
export function downscaleImage(dataUrl, maxSize = MAX_PHOTO_SIZE) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const longest = Math.max(img.width, img.height);
      if (longest <= maxSize) {
        resolve({ dataUrl, width: img.width, height: img.height });
        return;
      }
      const scale = maxSize / longest;
      const width = Math.round(img.width * scale);
      const height = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      // JPEG для фотографий заметно легче PNG, а прозрачность в заметке не нужна.
      resolve({ dataUrl: canvas.toDataURL("image/jpeg", 0.85), width, height });
    };
    img.onerror = () => reject(new Error("bad-image"));
    img.src = dataUrl;
  });
}
