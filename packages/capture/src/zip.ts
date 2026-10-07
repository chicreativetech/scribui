import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

/**
 * A minimal zip reader for the tool downloads (Google's platform tools):
 * stored and deflated entries, Unix file modes kept so binaries stay
 * executable. No zip64, no encryption; entries that would land outside the
 * target folder are refused.
 */

export type ZipEntry = { name: string; mode: number; dir: boolean; data: () => Buffer };

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function readZip(buf: Buffer): ZipEntry[] {
  // the end record sits in the last 22 bytes plus a comment of up to 64 KB
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CENTRAL) throw new Error("broken zip directory");
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (size === 0xffffffff || local === 0xffffffff) throw new Error("zip64 isn't supported");
    // made on Unix (3): the high 16 bits are the file's mode
    const unixMode = madeBy === 3 ? attrs >>> 16 : 0;
    const dir = name.endsWith("/");
    entries.push({
      name,
      dir,
      mode: unixMode & 0o777,
      data: () => {
        if (buf.readUInt32LE(local) !== LOCAL) throw new Error(`broken zip entry ${name}`);
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + size);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return inflateRawSync(raw);
        throw new Error(`zip entry ${name} uses compression method ${method}`);
      },
    });
  }
  return entries;
}

/** Write a zip's files under `into`; returns how many files were written. */
export async function extractZip(buf: Buffer, into: string): Promise<number> {
  const root = resolve(into);
  let files = 0;
  for (const e of readZip(buf)) {
    const target = resolve(root, e.name);
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`zip entry ${e.name} points outside the folder`);
    if (e.dir) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, e.data());
    if (e.mode && process.platform !== "win32") await chmod(target, e.mode);
    files++;
  }
  return files;
}
