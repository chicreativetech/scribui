import type { Platform, ScreenManifest } from "./schemas.js";

/** Text and files intentcue writes for the user and their coding agent. */

export const SCREENS_GUIDE_FILE = "screens.md";

/** The one line the user pastes into their coding agent to get screens.json filled. */
export function screensPrompt(platform: Platform, baseUrl?: string): string {
  const where = platform === "web" && baseUrl ? ` The app runs at ${baseUrl}.` : "";
  return `List every screen and important state of this app in .intentcue/screens.json, following .intentcue/screens.md.${where}`;
}

/** The one line the user pastes after pressing Send. */
export const IMPLEMENT_PROMPT = "Implement .intentcue/latest/review.md";

export function screensGuide(platform: Platform, opts: { baseUrl?: string; appId?: string } = {}): string {
  const common = `# How to fill .intentcue/screens.json

intentcue captures every screen listed in \`screens.json\` so the user can review them visually.
Replace the example entries with the app's real screens.

- \`id\`: short, stable, kebab-case (\`checkout-card-error\`). Never reuse an id for a different screen.
- \`title\`: what a person calls the screen.
- \`group\`: screens with the same group sit together on the board (a flow or a tab).
- List important **states** as separate screens: empty, error, loading-finished, logged in.
- Optional \`sources\`: globs of the files that draw the screen. Then only screens whose code changed are recaptured.
- Optional \`app.sharedSources\`: theme / design-system globs; a change there recaptures every screen.
- Prefer stable ids in the UI (accessibility identifiers, testIDs, \`data-testid\`). Review instructions then name them.
`;
  if (platform === "web") {
    return `${common}
## Web

Each screen is a URL relative to \`app.baseUrl\`${opts.baseUrl ? ` (currently \`${opts.baseUrl}\`)` : ""}.

\`\`\`json
{
  "version": 1,
  "app": { "name": "Shop", "platform": "web", "baseUrl": "${opts.baseUrl ?? "http://localhost:3000"}" },
  "screens": [
    { "id": "cart", "title": "Cart", "group": "Purchase flow", "url": "/cart",
      "viewport": { "width": 390, "height": 844, "deviceScaleFactor": 2 }, "sources": ["src/pages/cart/**"] },
    { "id": "checkout-error", "title": "Checkout, card declined", "group": "Purchase flow",
      "url": "/checkout", "setup": "flows/checkout-error.mjs" }
  ]
}
\`\`\`

- \`viewport\` defaults to a 390×844 phone at 2×. Use \`{ "width": 1440, "height": 900 }\` for desktop; add \`"fullPage": true\` for whole pages.
- When a URL alone can't reach a state (logged in, filled form, error), add a \`setup\` script in \`.intentcue/flows/\`:

\`\`\`js
// .intentcue/flows/checkout-error.mjs: receives the Playwright page after the URL loaded
export default async function (page) {
  await page.fill("[data-testid=cardInput]", "4000 0000 0000 0002");
  await page.click("[data-testid=payButton]");
}
\`\`\`
`;
  }
  if (platform === "android") {
    return `${common}
## Android

Each screen has a \`flow\`: a script in \`.intentcue/flows/\` that opens the app and navigates to the screen.
The easiest is a shell script using the bundled helper (no extra tools needed):

\`\`\`sh
#!/bin/sh
# .intentcue/flows/shop-category.sh (make it executable: chmod +x)
set -e; cd "$(dirname "$0")"
node adb.mjs launch                        # restart the app on its first screen
node adb.mjs tap "Shop"                    # tap the element whose text or content description matches
node adb.mjs tap "Stress & recovery"
\`\`\`

\`\`\`json
{ "id": "shop-category", "title": "Shop category", "group": "Shop", "flow": "flows/shop-category.sh",
  "sources": ["app/src/main/java/**/feature/shop/**"] }
\`\`\`

- \`app.bundleId\` is the application id${opts.appId ? ` (\`${opts.appId}\`)` : ""}.
- \`app.build\` (optional) is the command that rebuilds and installs the app, e.g. \`./gradlew installDebug\` (on Windows: \`gradlew.bat installDebug\`).
- Maestro flows (\`.yaml\`) work too and are faster for long paths.
- Compose: \`Modifier.testTag("payButton")\` plus \`testTagsAsResourceId = true\` makes elements show up by id.
`;
  }
  return `${common}
## iOS (simulator)

Each screen has a Maestro \`flow\` in \`.intentcue/flows/\` that opens the app and navigates to the screen:

\`\`\`yaml
# .intentcue/flows/checkout.yaml
appId: ${opts.appId ?? "com.example.app"}
---
- launchApp
- tapOn: "Cart"
- tapOn: "Checkout"
\`\`\`

\`\`\`json
{ "id": "checkout", "title": "Checkout", "group": "Purchase flow", "flow": "flows/checkout.yaml" }
\`\`\`

- \`app.bundleId\` is the bundle identifier.
- \`app.build\` (optional) is the command that rebuilds and installs the app on the simulator.
- Set \`accessibilityIdentifier\` (SwiftUI \`.accessibilityIdentifier("payButton")\`, React Native \`testID\`) so elements show up by id.
`;
}

/** Android navigation helper used by shell-script flows (no Maestro needed). */
export function androidFlowHelper(appId: string): string {
  return `// intentcue Android navigation helper: node adb.mjs launch | tap "<text>" | back | wait <ms>
// ANDROID_SERIAL (set by intentcue) picks the device; adb is put on PATH by intentcue.
import { execFileSync } from "node:child_process";

const APP = process.env.INTENTCUE_APP_ID || ${JSON.stringify(appId)};
const adb = (...args) => execFileSync("adb", args, { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

function nodes() {
  // a failed dump ("null root node" while the app is starting) exits 0 and leaves an
  // old file behind: delete it first and treat errors as "not ready yet"
  adb("shell", "rm", "-f", "/sdcard/intentcue_nav.xml");
  let out = "";
  try {
    out = adb("shell", "uiautomator", "dump", "/sdcard/intentcue_nav.xml");
  } catch {
    return [];
  }
  if (/ERROR/i.test(out)) return [];
  let xml = "";
  try {
    xml = adb("exec-out", "cat", "/sdcard/intentcue_nav.xml");
  } catch {
    return [];
  }
  return [...xml.matchAll(/<node [^>]*>/g)].map(([tag]) => {
    const attr = (k) => decode(new RegExp(\` \${k}="([^"]*)"\`).exec(tag)?.[1] ?? "");
    const b = /\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]/.exec(attr("bounds"));
    return { text: attr("text"), desc: attr("content-desc"), id: attr("resource-id"), x: b ? (+b[1] + +b[3]) / 2 : 0, y: b ? (+b[2] + +b[4]) / 2 : 0 };
  });
}

async function tap(label) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const all = nodes();
    const hit =
      all.find((n) => n.text === label || n.desc === label || n.id.endsWith(label)) ??
      all.find((n) => n.text.includes(label) || n.desc.includes(label));
    if (hit) {
      adb("shell", "input", "tap", String(Math.round(hit.x)), String(Math.round(hit.y)));
      await sleep(700);
      return;
    }
    await sleep(400);
  }
  console.error(\`not found on screen: "\${label}"\`);
  process.exit(1);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "launch") {
  adb("shell", "am", "force-stop", APP);
  adb("shell", "monkey", "-p", APP, "-c", "android.intent.category.LAUNCHER", "1");
  // wait until the app has focus and shows real content (a splash screen has no text), up to 30 s
  const focused = () => adb("shell", "dumpsys", "window").split("\\n").some((l) => l.includes("mCurrentFocus") && l.includes(APP));
  const until = Date.now() + 30_000;
  await sleep(800);
  while (Date.now() < until && !(focused() && nodes().some((n) => n.text.trim()))) await sleep(400);
  await sleep(300);
} else if (cmd === "tap") await tap(arg);
else if (cmd === "back") {
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  await sleep(500);
} else if (cmd === "wait") await sleep(Number(arg) || 500);
else {
  console.error('usage: node adb.mjs launch | tap "<text>" | back | wait <ms>');
  process.exit(1);
}
`;
}

export function androidFlowScript(taps: string[]): string {
  return ["#!/bin/sh", "set -e", 'cd "$(dirname "$0")"', "node adb.mjs launch", ...taps.map((t) => `node adb.mjs tap ${JSON.stringify(t)}`), ""].join("\n");
}

/** Starter manifest written on first run; the agent replaces the screens. */
export function starterManifest(platform: Platform, name: string, opts: { baseUrl?: string; appId?: string; build?: string } = {}): ScreenManifest {
  if (platform === "web") {
    return {
      version: 1,
      app: { name, platform, baseUrl: opts.baseUrl ?? "http://localhost:3000" },
      screens: [{ id: "home", title: "Home", group: "Main", url: "/", viewport: { width: 390, height: 844, deviceScaleFactor: 2 } }],
    };
  }
  const app: ScreenManifest["app"] = { name, platform, bundleId: opts.appId ?? "com.example.app" };
  if (opts.build) app.build = opts.build;
  return {
    version: 1,
    app,
    screens: [
      { id: "home", title: "Home", group: "Main", flow: platform === "android" ? "flows/home.sh" : "flows/home.yaml" },
    ],
  };
}
