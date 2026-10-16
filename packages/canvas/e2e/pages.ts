import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A web page of the test's own, on this computer: what a link or a browser tab opens. */
export async function servePage(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/pricing.html`, close: () => new Promise((r) => server.close(() => r())) };
}
