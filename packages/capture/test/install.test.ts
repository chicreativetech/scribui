import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractZip, installPlan, readZip, runInstall, type InstallEnv } from "../src/index.js";

/** A tiny zip writer for the tests: Unix-made entries, stored or deflated. */
function zip(files: { name: string; data: string; mode?: number; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.from(f.data);
    const body = f.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(f.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(f.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4);
    c.writeUInt16LE(f.deflate ? 8 : 0, 10);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((f.mode ?? 0o644) | 0o100000) << 16 >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const env = (p: Partial<InstallEnv>): InstallEnv => ({ os: "darwin", brew: null, winget: null, npm: null, xcodeApp: null, ...p });

describe("zip reader", () => {
  it("unpacks stored and deflated files and keeps executable modes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scribui-zip-"));
    const n = await extractZip(zip([{ name: "platform-tools/adb", data: "#!/bin/sh\n", mode: 0o755 }, { name: "platform-tools/NOTICE.txt", data: "x".repeat(5000), deflate: true }]), dir);
    expect(n).toBe(2);
    expect(readFileSync(join(dir, "platform-tools/NOTICE.txt"), "utf8")).toBe("x".repeat(5000));
    if (process.platform !== "win32") expect(statSync(join(dir, "platform-tools/adb")).mode & 0o777).toBe(0o755);
  });

  it("refuses entries outside the folder and non-zips", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scribui-zip-"));
    await expect(extractZip(zip([{ name: "../evil", data: "x" }]), dir)).rejects.toThrow(/outside/);
    expect(() => readZip(Buffer.from("not a zip at all, not even close"))).toThrow(/not a zip/);
  });
});

describe("install plans", () => {
  it("installs adb by download everywhere, with Google's terms", () => {
    for (const os of ["darwin", "win32", "linux"] as const) {
      const p = installPlan("adb", env({ os }));
      expect(p.auto && p.steps[0]).toMatchObject({ kind: "platform-tools" });
      expect(p.auto && p.terms).toMatch(/developer\.android\.com/);
    }
  });

  it("uses package managers only where they exist", () => {
    expect(installPlan("axe", env({})).auto).toBe(false);
    expect(installPlan("axe", env({ brew: "/opt/homebrew/bin/brew" })).auto).toBe(true);
    expect(installPlan("axe", env({ os: "linux", brew: "/x/brew" })).auto).toBe(false);
    expect(installPlan("emulator", env({ os: "win32", winget: "winget" })).auto).toBe(true);
    expect(installPlan("emulator", env({ os: "linux" })).auto).toBe(false);
    expect(installPlan("playwright", env({})).auto).toBe(false);
    expect(installPlan("playwright", env({ npm: "/usr/bin/npm" })).auto).toBe(true);
  });

  it("fixes Xcode's selection with the password prompt only when Xcode.app is there", () => {
    expect(installPlan("xcode", env({})).auto).toBe(false);
    const p = installPlan("xcode", env({ xcodeApp: "/Applications/Xcode.app" }));
    expect(p.auto && p.steps[0]).toMatchObject({ kind: "admin" });
    expect(p.auto && p.steps[0]?.kind === "admin" && p.steps[0].script).toContain("'/Applications/Xcode.app/Contents/Developer'");
  });

  it("runs steps in order, passing output on; optional failures don't stop it", async () => {
    const lines: string[] = [];
    const node = process.execPath;
    const ok = await runInstall(
      {
        auto: true,
        does: "test",
        steps: [
          { kind: "run", label: "one", cmd: node, args: ["-e", "console.log('hello'); process.stderr.write('a\\rb\\n')"] },
          { kind: "run", label: "two", cmd: node, args: ["-e", "process.exit(3)"], optional: true },
        ],
      },
      (l) => lines.push(l),
    );
    expect(ok).toEqual({ ok: true });
    expect(lines).toEqual(["$ one", "hello", "a", "b", "$ two", "(skipped: exit 3)"]);
    const bad = await runInstall({ auto: true, does: "t", steps: [{ kind: "run", label: "fail", cmd: node, args: ["-e", "process.exit(2)"] }] }, () => {});
    expect(bad).toEqual({ ok: false, error: "fail failed (exit 2)" });
  });
});
