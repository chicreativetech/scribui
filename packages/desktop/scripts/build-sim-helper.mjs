// Builds vendor/scribui-sim (native/scribui-sim/main.swift): the iOS
// Simulator's live screen and input for the device tab. macOS only; elsewhere
// (and when it's already up to date) it does nothing.
//
// It links against idb's FBControlCore and FBSimulatorControl as AXe ships
// them (brew install cameroncooke/axe/axe), and finds them there at runtime:
// AXe is the iOS tool ScribUI asks for anyway. Compiling needs two things
// AXe's build had: idb's private headers (fetched at the commit AXe 1.8.0 was
// built from) and a copy of FBSimulatorControl's module interface with two
// qualifier bugs fixed (the module has a class of its own name, so
// `FBSimulatorControl.FBFoo` doesn't resolve; same for `IOSurface.IOSurface`).
//
//   node scripts/build-sim-helper.mjs [--force]
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") process.exit(0);

const IDB_REPO = "https://github.com/cameroncooke/idb.git";
const IDB_REF = "604c51013438f0c3603b720a05a44b7c5b8f286d";
/** Where AXe's frameworks are, Apple Silicon and Intel Homebrew. */
const AXE_FRAMEWORKS = ["/opt/homebrew/opt/axe/libexec/Frameworks", "/usr/local/opt/axe/libexec/Frameworks"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "vendor");
const src = join(root, "native/scribui-sim/main.swift");
const bin = join(vendor, "scribui-sim");
const work = join(vendor, "sim-build");

if (!process.argv.includes("--force") && existsSync(bin) && statSync(bin).mtimeMs > statSync(src).mtimeMs) {
  console.log("scribui-sim: up to date");
  process.exit(0);
}

const frameworks = AXE_FRAMEWORKS.find((p) => existsSync(join(p, "FBSimulatorControl.framework")));
if (!frameworks) {
  // not fatal: the app runs without it and the device tab says what's missing
  console.warn("scribui-sim: AXe isn't installed, so the iOS device view can't be built (brew install cameroncooke/axe/axe)");
  process.exit(0);
}

// idb's private headers, at the commit AXe was built from
const headers = join(work, "idb");
if (!existsSync(join(headers, "PrivateHeaders/CoreSimulator"))) {
  rmSync(headers, { recursive: true, force: true });
  mkdirSync(headers, { recursive: true });
  const git = (...a) => execFileSync("git", ["-C", headers, ...a], { stdio: ["ignore", "ignore", "inherit"] });
  git("init", "-q");
  git("remote", "add", "origin", IDB_REPO);
  git("sparse-checkout", "set", "PrivateHeaders");
  git("fetch", "-q", "--depth", "1", "origin", IDB_REF);
  git("checkout", "-q", "FETCH_HEAD");
}

// a patched copy of the frameworks' interfaces, for compiling only
const fw = join(work, "fw");
rmSync(fw, { recursive: true, force: true });
mkdirSync(fw, { recursive: true });
for (const f of ["FBControlCore.framework", "FBSimulatorControl.framework", "XCTestBootstrap.framework"]) cpSync(join(frameworks, f), join(fw, f), { recursive: true, verbatimSymlinks: true });
const modules = join(fw, "FBSimulatorControl.framework/Modules/FBSimulatorControl.swiftmodule");
for (const f of readdirSync(modules)) {
  const p = join(modules, f);
  if (f.endsWith(".swiftinterface"))
    writeFileSync(
      p,
      readFileSync(p, "utf8")
        .replace(/FBSimulatorControl\.(FB\w+|Async\w+|DEFAULT_\w+)/g, "$1")
        .replace(/IOSurface\.IOSurface/g, "IOSurfaceRef"),
    );
  else if (f.endsWith(".swiftmodule")) rmSync(p);
}

const ph = join(headers, "PrivateHeaders");
const includes = ["", "AccessibilityPlatformTranslation", "AXRuntime", "CoreSimDeviceIO", "CoreSimulator", "CoreSimulatorUtilities", "SimulatorKit"].map(
  (d) => `-I${join(ph, d)}`,
);
mkdirSync(vendor, { recursive: true });
// one binary for both Macs (the app ships arm64 and x64 builds; AXe's frameworks are universal)
const slices = ["arm64", "x86_64"].map((arch) => {
  const out = join(work, `scribui-sim-${arch}`);
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-target",
      `${arch}-apple-macos14`,
      "-parse-as-library",
      "-O",
      "-F",
      fw,
      ...includes,
      "-framework",
      "FBControlCore",
      "-framework",
      "FBSimulatorControl",
      // at runtime: AXe's own copies (never the patched ones)
      ...AXE_FRAMEWORKS.flatMap((p) => ["-Xlinker", "-rpath", "-Xlinker", p]),
      "-module-cache-path",
      join(work, "module-cache"),
      src,
      "-o",
      out,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  return out;
});
execFileSync("lipo", ["-create", ...slices, "-output", bin]);
// AXe's frameworks name themselves by absolute path; @rpath finds them under either Homebrew prefix
for (const f of ["FBControlCore", "FBSimulatorControl"])
  execFileSync("install_name_tool", ["-change", join(frameworks, `${f}.framework/Versions/A/${f}`), `@rpath/${f}.framework/Versions/A/${f}`, bin]);
execFileSync("codesign", ["--force", "--sign", "-", bin]);
console.log(`scribui-sim: built against ${frameworks}`);
