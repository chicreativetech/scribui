// Zero-dependency static server for the sample app.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const port = Number(process.env.PORT ?? 5178);
const routes = { "/": "index.html", "/cart": "cart.html", "/checkout": "checkout.html", "/done": "done.html" };
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const file = routes[url.pathname] ?? url.pathname.slice(1);
  try {
    const body = await readFile(join(root, file));
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`sample app on http://127.0.0.1:${port}`));
