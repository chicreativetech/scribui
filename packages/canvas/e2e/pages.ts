import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

type File = { type: string; body: string | Buffer; headers?: Record<string, string> };

/**
 * A web site of the test's own, on this computer: what a link or a browser tab opens.
 * One page (served at /pricing.html), or files by path. `hits` lists what was asked for.
 */
export async function servePage(
  site: string | Record<string, File>,
): Promise<{ url: string; origin: string; hits: string[]; close: () => Promise<void> }> {
  const files: Record<string, File> = typeof site === "string" ? { "/pricing.html": { type: "text/html; charset=utf-8", body: site } } : site;
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    hits.push(path);
    const f = files[path];
    if (!f) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": f.type, "access-control-allow-origin": "*", ...f.headers });
    res.end(f.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return { url: `${origin}${Object.keys(files)[0]}`, origin, hits, close: () => new Promise((r) => server.close(() => r())) };
}
