// Запасной статический сервер на голом Node — на случай, когда интернета нет,
// а кеш npx почищен и `npx serve` больше не поднимается.
// Запуск: node server.js   (потом открыть http://localhost:5173)

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 5173;
const ROOT = __dirname;

// Браузер не выполнит ES-модуль, если тип не text/javascript, поэтому
// заголовок Content-Type проставляем руками — без него приложение не стартует.
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const server = http.createServer(function (request, response) {
  const urlPath = decodeURIComponent(request.url.split("?")[0]);
  let filePath = path.join(ROOT, urlPath === "/" ? "/index.html" : urlPath);

  // Защита от запросов вида /../../ — наружу из папки проекта не выпускаем.
  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.stat(filePath, function (error, stats) {
    if (!error && stats.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    fs.readFile(filePath, function (readError, content) {
      if (readError) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("404: " + urlPath);
        return;
      }

      const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
      // no-store: заголовков валидации сервер не шлёт, и без явного запрета
      // Chrome кеширует модули «на глазок» — правка в файле есть, а в браузере
      // её нет. На этом уже терялось полдня отладки.
      response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      response.end(content);
    });
  });
});

// Сообщения латиницей намеренно: консоль Windows по умолчанию не в UTF-8,
// и русский текст в ней превратится в кракозябры.
server.listen(PORT, function () {
  console.log("Server: http://localhost:" + PORT);
  console.log("Stop: Ctrl+C");
});
