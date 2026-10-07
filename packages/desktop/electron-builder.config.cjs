/**
 * Packaging. The main process is one bundle (dist/main.cjs); the native PNG
 * renderer is staged into dist/node_modules (scripts/stage-native.mjs) and
 * unpacked from the asar archive. The package itself has no runtime
 * dependencies.
 *
 * Signing turns itself on when its secrets are present (see RELEASING.md):
 * - macOS: CSC_LINK + CSC_KEY_PASSWORD (Developer ID Application certificate)
 *   sign with the hardened runtime; APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD +
 *   APPLE_TEAM_ID also notarise. Without them: an ad-hoc signature, enough
 *   for Apple Silicon to run a build.
 * - Windows: AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET with
 *   SCRIBUI_AZURE_ENDPOINT, SCRIBUI_AZURE_ACCOUNT, SCRIBUI_AZURE_PROFILE and
 *   SCRIBUI_AZURE_PUBLISHER sign through Azure Trusted Signing. Without them:
 *   unsigned (SmartScreen asks once).
 */
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const env = process.env;
const macSigned = !!env.CSC_LINK;
const macNotarised = macSigned && !!(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID);
const winSigned = !!(env.AZURE_TENANT_ID && env.AZURE_CLIENT_ID && env.AZURE_CLIENT_SECRET && env.SCRIBUI_AZURE_ENDPOINT);

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "dev.scribui.desktop",
  productName: "ScribUI",
  artifactName: "ScribUI-${version}-${os}-${arch}.${ext}",
  directories: { output: "release", buildResources: "build" },
  files: ["dist/**/*", "!dist/**/*.map", "!dist/spike*", "package.json"],
  extraResources: [
    // the canvas, served by the project's server
    { from: "../canvas/dist", to: "canvas" },
    // the Android device view's server, pinned (scripts/fetch-scrcpy.mjs)
    { from: "vendor/scrcpy-server", to: "scrcpy-server" },
    { from: "vendor/scrcpy-LICENSE", to: "scrcpy-LICENSE" },
  ],
  asarUnpack: ["dist/node_modules/@resvg/**"],
  protocols: [{ name: "ScribUI project", schemes: ["scribui"] }],
  // releases are drafts on GitHub (release.yml); the updater reads latest*.yml from there
  publish: [{ provider: "github", owner: "chicreativetech", repo: "scribui", releaseType: "draft" }],
  // the notes the release and the update dialog show (scripts/release-notes.mjs writes them from CHANGELOG.md)
  ...(existsSync(join(__dirname, "build/release-notes.md")) ? { releaseInfo: { releaseNotesFile: "build/release-notes.md" } } : {}),
  mac: {
    extraResources: [
      // the iOS Simulator's live view (scripts/build-sim-helper.mjs); runs on AXe's frameworks
      { from: "vendor/scribui-sim", to: "scribui-sim" },
    ],
    // dmg to install, zip for the updater
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    category: "public.app-category.developer-tools",
    ...(macSigned
      ? {
          hardenedRuntime: true,
          entitlements: "build/entitlements.mac.plist",
          // the helper loads AXe's frameworks from Homebrew, signed by another team
          entitlementsInherit: "build/entitlements.mac.plist",
          binaries: ["Contents/Resources/scribui-sim"],
          notarize: macNotarised,
        }
      : { identity: "-", hardenedRuntime: false }),
  },
  dmg: { writeUpdateInfo: false },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    ...(winSigned
      ? {
          azureSignOptions: {
            endpoint: env.SCRIBUI_AZURE_ENDPOINT,
            codeSigningAccountName: env.SCRIBUI_AZURE_ACCOUNT,
            certificateProfileName: env.SCRIBUI_AZURE_PROFILE,
            publisherName: env.SCRIBUI_AZURE_PUBLISHER,
          },
        }
      : {}),
  },
  nsis: { oneClick: true, perMachine: false, differentialPackage: false },
  linux: {
    // Linux names the executable after the package (@scribui/desktop), which can't be a file name
    executableName: "scribui",
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] },
    ],
    category: "Development",
    maintainer: "ScribUI",
    synopsis: "Visual review between you and your coding agent",
  },
};
