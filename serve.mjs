#!/usr/bin/env node
// Tiny zero-dependency static server for the generator page.
//   node serve.mjs [--port 8080] [--host 127.0.0.1]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(flag("port", process.env.PORT || 8080));
const HOST = flag("host", "127.0.0.1");

const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon"
};

createServer(async (req, res) => {
    try {
        const url = new URL(req.url, "http://localhost");
        let path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
        if (path !== ROOT && !path.startsWith(ROOT + sep)) throw Object.assign(new Error("forbidden"), { code: 403 });
        if (path.split(sep).some(part => part.startsWith(".") && part.length > 1)) throw Object.assign(new Error("hidden"), { code: 404 });
        if ((await stat(path)).isDirectory()) path = join(path, "index.html");
        const body = await readFile(path);
        res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-cache" });
        res.end(req.method === "HEAD" ? undefined : body);
    } catch (error) {
        const code = error.code === 403 ? 403 : 404;
        res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
        res.end(code === 403 ? "Forbidden" : "Not found");
    }
}).listen(PORT, HOST, () => {
    console.log(`Discord Badge Unlocker: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/`);
});
