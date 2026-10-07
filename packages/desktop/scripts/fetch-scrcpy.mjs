// Puts the scrcpy-server jar the app's client is written for (SCRCPY_VERSION
// in packages/capture/src/live/scrcpy.ts) into vendor/, checked against its
// SHA-256, with scrcpy's licence (Apache 2.0). The app ships exactly this jar,
// never whichever scrcpy happens to be installed. Already there: nothing to do.
//
//   node scripts/fetch-scrcpy.mjs
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "4.1";
const SHA256 = "deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae";
const BASE = "https://github.com/Genymobile/scrcpy";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "vendor");
const jar = join(dir, "scrcpy-server");
const licence = join(dir, "scrcpy-LICENSE");
const sha = (b) => createHash("sha256").update(b).digest("hex");

// the client pins the same version: catch one being updated without the other
const client = readFileSync(join(root, "../capture/src/live/scrcpy.ts"), "utf8");
if (!client.includes(`SCRCPY_VERSION = "${VERSION}"`) || !client.includes(SHA256)) {
  console.error(`fetch-scrcpy: packages/capture/src/live/scrcpy.ts isn't pinned to scrcpy ${VERSION} (${SHA256})`);
  process.exit(1);
}

mkdirSync(dir, { recursive: true });
if (existsSync(jar) && sha(readFileSync(jar)) === SHA256 && existsSync(licence)) {
  console.log(`scrcpy-server ${VERSION}: in place`);
  process.exit(0);
}

const get = async (url) => {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  return Buffer.from(await r.arrayBuffer());
};
const data = await get(`${BASE}/releases/download/v${VERSION}/scrcpy-server-v${VERSION}`);
if (sha(data) !== SHA256) {
  console.error(`fetch-scrcpy: scrcpy-server-v${VERSION} has SHA-256 ${sha(data)}, expected ${SHA256}`);
  process.exit(1);
}
writeFileSync(jar, data);
writeFileSync(licence, `scrcpy-server ${VERSION} (${BASE}), shipped unmodified.\n\n${(await get(`https://raw.githubusercontent.com/Genymobile/scrcpy/v${VERSION}/LICENSE`)).toString()}`);
console.log(`scrcpy-server ${VERSION}: fetched`);
