import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const MISSING_BUILD = `<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ribhu Voyager — build needed</title>
<style>
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: #0b0c0e; color: #e9e7e2; font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  main { max-width: 34rem; padding: 2rem; }
  code { background: #1a1c20; color: #ffb454; padding: .15rem .4rem; border-radius: .35rem; }
  h1 { font-size: 1.4rem; letter-spacing: -.02em; }
  p { color: #a6a29a; }
</style>
<main>
  <h1>Ribhu Voyager is not built yet</h1>
  <p>The gateway is running, but <code>apps/mobile/dist</code> is missing.</p>
  <p>Run <code>npm run build</code> in the project root, then reload this page.</p>
</main>
</html>`;

function cacheControl(path: string): string {
  if (path.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  if (path === "/sw.js" || path === "/index.html" || path === "/") {
    return "no-cache";
  }
  return "public, max-age=3600";
}

export type StaticHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean>;

export function createStaticHandler(distDir: string): StaticHandler {
  return async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end("Method not allowed");
      return true;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      response.writeHead(400).end("Bad path");
      return true;
    }

    if (pathname === "/") pathname = "/index.html";

    const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
    const absolute = join(distDir, relative);
    if (!absolute.startsWith(distDir + sep) && absolute !== distDir) {
      response.writeHead(403).end("Forbidden");
      return true;
    }

    let file = absolute;
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error("not a file");
    } catch {
      // SPA fallback: extensionless paths render the app shell.
      if (extname(pathname) === "") {
        file = join(distDir, "index.html");
      } else {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return true;
      }
    }

    let info;
    try {
      info = await stat(file);
    } catch {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      });
      response.end(MISSING_BUILD);
      return true;
    }

    response.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "content-length": String(info.size),
      "cache-control": cacheControl(pathname),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });

    if (request.method === "HEAD") {
      response.end();
      return true;
    }

    createReadStream(file).pipe(response);
    return true;
  };
}
