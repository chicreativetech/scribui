# ScribUI

**Point, don't describe.** A visual review layer between you and your coding agent.

Your agent builds app screens. ScribUI captures them as tiles on a canvas. You circle, strike out, arrow and comment right on the screenshots, and every mark snaps to a real UI element. When you press **Send**, ScribUI writes precise, file-based instructions (`review.md`) that any agent can read: Claude Code, Codex, Cursor and others.

The tool never edits your app and has no AI inside. It supplies context; your agent supplies the intelligence.

```
  capture ──▶ annotate ──▶ send ──▶ agent applies ──▶ capture …
  (ScribUI)   (you)       (ScribUI)  (your agent)
```

## Install

ScribUI is not published to npm yet. Build it from this repo and install the CLI globally:

```sh
git clone <this repo> scribui && cd scribui
pnpm install && pnpm build
cd packages/cli && npm pack && npm install -g ./scribui-0.1.0.tgz
scribui --help
```

To use it in one project only, run `npm install -D /path/to/scribui-0.1.0.tgz` there and call it with `npx scribui`. Node 20 or newer is required.

You don't need to install anything else up front: `scribui` checks for the capture tools it needs and offers to install them.

## Try it on the sample app first

A small web shop with five screens ships in `examples/checkout-web`:

```sh
node examples/checkout-web/server.mjs &          # sample app on http://localhost:5178
scribui --dir examples/checkout-web            # opens the canvas
```

## How to use it

Start your app the way you always do, then run one command in the project folder:

```sh
scribui
```

That's the whole interface. The first time, it sets the project up and walks you through the rest; after that it opens the canvas on your latest screens.

ScribUI looks at the project to decide what it is. A folder without Android or iOS markers is treated as a web app. When it finds a Gradle project, an Xcode project, React Native, Expo or Flutter, it asks which platform to review. To skip the question, pass `--platform web|android|ios`.

| | Web | Android App | iOS App |
| --- | --- | --- | --- |
| Runs on | macOS, Windows, Linux | macOS, Windows, Linux | **macOS only** |
| Captures from | your local dev server | emulator or phone over USB | iOS Simulator |
| ScribUI installs for you | Playwright + Chromium | adb (via Homebrew) | Maestro |
| You install yourself | Node 20+ | Android Studio or the platform tools, if Homebrew isn't available | Xcode |
| Speed | about 1 s per screen | about 10 s per screen (beta) | about 10 s per screen (beta) |

### Web

**What you need:** Node 20 or newer and your app running locally. Any framework works (Vite, Next.js, Angular, plain HTML), because ScribUI only talks to the running page.

1. **Start your app,** e.g. `npm run dev`.
2. **Run `scribui`.** The first time, it:
   - asks *"Which localhost port does your web app use?"*. Dev servers that are running are listed first, the one started from this folder at the top, with page titles. Common ports follow, marked "not running yet", and **Other port…** takes a port number or a full URL. The answer is saved as `app.baseUrl` in `.scribui/screens.json`;
   - creates `.scribui/` and adds a short "Visual design review" section to `AGENTS.md`;
   - if Playwright is missing, asks *"Install Playwright? (Y/n)"* and adds it as a dev dependency with your package manager (npm, pnpm, yarn or bun). A project without `package.json` gets a shared copy in `~/.scribui/runtime` instead, so nothing is added to it. Then it downloads Playwright's Chromium (about 150 MB, once);
   - if nothing answers at the chosen address, waits until your app is up (press Enter to go on anyway).

   There's no list of screens to write first: you pick the views yourself.
3. **A Chrome window opens on the canvas,** showing the **app** tab: your running app, embedded. Use it the way you normally would: log in, click through, open a menu, fill in a form. Switch between the **board** and the **app** with the toggle in the top bar or `L`. The app keeps its state when you switch.
4. **Press Capture view** when you see something you want to comment on. ScribUI screenshots the app exactly as it is, reads its elements, and adds the view to the open round (and to `.scribui/screens.json`, marked `"live": true`). Name it first if you like, or pick **replace "…"** to update a view you captured earlier. The size picker renders the app at desktop, laptop, tablet or phone width, so views line up on the board.
5. **Annotate** (see below) and press **Send to agent**. Paste the prompt it shows into your agent:

   ```
   Implement .scribui/latest/review.md
   ```

6. **When the agent is done,** switch to the app tab, get back to the same view and press **Capture view** again; choosing **replace "…"** puts the new version where the old one was. Your next capture starts a new round, and the views you didn't recapture are carried over, marked `↺`.

ScribUI keeps the Chrome window's profile per project in `~/.scribui/browser/`, so logins survive between sessions. When your app runs on `localhost`, the canvas does too, so the app's cookies work inside the app tab. Press `o` in the terminal to bring the window back if you close it.

Views captured in the app tab are never recaptured automatically: their state (a login, an open menu, typed text) can't be rebuilt from the URL. Screens your agent lists in `screens.json` with a `url` and optional setup script still work as before, and **↻ Recapture** captures those.

**Limits:** apps that refuse to be embedded (`X-Frame-Options` or a `frame-ancestors` policy, common on third-party login pages) don't show in the app tab. Capturing only works in the Chrome window ScribUI opens; in another browser the app tab is view-only.

### Android App

**What you need:** your app's Android build, and an emulator (from Android Studio's Device Manager) or an Android phone with USB debugging on. Works on macOS, Windows and Linux. Android capture is in beta.

1. **Start the emulator or connect your phone,** with the app installed. If nothing is connected, ScribUI lists your emulators and offers to start one.
2. **Run `scribui`** and pick **Android** (preselected when only an Android project is found). The first time, it:
   - creates `.scribui/`, a navigation helper for flows, and the `AGENTS.md` section;
   - checks for **adb**. When it's missing, ScribUI offers to install the platform tools with Homebrew; without Homebrew, install Android Studio (or the platform tools alone);
   - recommends **Maestro** for faster navigation flows. It's optional: ScribUI's built-in adb helper works without it;
   - picks the device, asking when several are connected, and remembers the choice in `screens.json`;
   - reads your app id from `app/build.gradle(.kts)` and checks that the app is installed. If it isn't, it offers to build and install it with the detected command: `./gradlew installDebug`, `npx expo run:android`, `npx react-native run-android` or `flutter run -d android --debug`. When `JAVA_HOME` is missing or older than 17, the build uses Android Studio's bundled JDK.
3. **Paste the same one line into your agent;** it writes `screens.json` plus a small flow per screen that taps its way there.
4. **The canvas opens** and the first round is captured. The canvas shows placeholders that fill in as each screen arrives.
5. **Annotate and Send,** then paste `Implement .scribui/latest/review.md` into your agent.
6. **When the agent is done,** the canvas says *"Rebuild and reinstall the app, then recapture."* Press **Rebuild & recapture** (when ScribUI knows your build command) or rebuild yourself and press **↻ Recapture**. Only the changed screens are captured, and the canvas shows the next round.

### iOS App

**What you need:** a Mac with Xcode and at least one iPhone simulator (Xcode → Window → Devices and Simulators). iOS capture is in beta.

> **iOS capture requires a Mac.** ScribUI captures from the iOS Simulator, which Apple only ships with Xcode on macOS, so iOS isn't available on Windows or Linux. Real iPhones aren't supported either. For a React Native, Expo or Flutter app, you can review its Android or web build on Windows and Linux. Layout and copy feedback carries over, but iOS-specific rendering such as fonts, safe areas and native controls won't show.

1. **Boot a simulator** with the app installed, or let ScribUI boot one for you.
2. **Run `scribui`** and pick **iOS** (preselected when only an iOS project is found). The first time, it:
   - creates `.scribui/`, a navigation helper for flows, and the `AGENTS.md` section;
   - checks for the Xcode command line tools (`xcode-select --install` if they're missing);
   - offers to install **Maestro**, which reads the screens and navigates between them (`idb` works too if you already use it). Maestro needs Java 17 or newer: `brew install openjdk@17`;
   - uses the booted simulator, asks which one when several are booted, or offers a list of iPhone simulators to boot;
   - reads your bundle id from `app.json` or the Xcode project and checks that the app is installed on the simulator. If it isn't, it offers to build it with `npx expo run:ios`, `npx react-native run-ios` or `flutter run -d ios --debug`. For a native Xcode project, build and run it on the simulator once with ▶ in Xcode, then run `scribui` again.
3. **Paste the same one line into your agent;** it writes `screens.json` plus a Maestro flow per screen.
4. **The canvas opens** and the first round is captured, with placeholders that fill in as each screen arrives.
5. **Annotate and Send,** then paste `Implement .scribui/latest/review.md` into your agent.
6. **When the agent is done,** rebuild the app (Xcode ▶, or **Rebuild & recapture** when ScribUI knows your build command) and press **↻ Recapture**.

### In the terminal while ScribUI runs

`r` recapture changed screens · `R` recapture all screens · `o` open the canvas again (on the web: bring back the Chrome window) · `q` quit. Everything else happens in the canvas.

### Several projects at once

Run `scribui` in each project. Each one gets its own canvas on the next free port (4382, 4383, …) in its own browser tab, and its own `.scribui/` folder. Running `scribui` or `scribui open` again in a project that already has a canvas open reopens that canvas instead of starting a second one, also when it was started with `--port`.

### Annotate

Every mark snaps to a real UI element. Press a key to pick a tool:

- **Comment** (`C`): click an element, type what should change, press `⏎`.
- **Circle** (`O`): drag a loop around one or more elements, then optionally type.
- **Remove** (`X`): click an element to strike it out.
- **Arrow** (`A`): drag from an element to where it should go. End on another element ("move it next to this"), on empty space ("move it here"), or on a different screen (a flow between screens).
- **Rectangle** (`R`): draw a box on empty space and type what to add there.
- **Draw** (`P`): a free-form note.
- **Rule** (`U`): click an element and shift-click more, even on other screens. Press `⏎` and type a rule that applies everywhere, like *"Primary buttons are full width"*. Rules go to `rules.md` and apply to all future work, not just this round.

After each mark, the element it attached to flashes, and a chip under the mark names it, e.g. `button#payButton "Pay now"`. When that's wrong, switch to select (`V`), click the chip and pick the parent, a child or "empty area". A yellow chip means ScribUI couldn't tell what you meant; press `N` to jump to the next one. Typing into a comment right next to a circle, arrow or remove merges it into that mark.

The **notes** tab lists every mark, and **review.md** shows exactly what the agent will receive, live as you draw. Everything autosaves; `⌘Z` undoes.

### What the agent receives

Sending writes `.scribui/rounds/<n>/review.md`, a structured `review.json` and annotated screenshots, then locks the round. The dialog first warns about marks without text or a clear target. A review reads like this:

```markdown
## Checkout (checkout-default)
Screenshot: screens/checkout-default.annotated.png

1. [R1-1] "Pay now" button (id: payButton): Too dominant, make it secondary to the order summary.
2. [R1-2] Remove the "Pay with Apple Pay" button (id: applePayButton).
3. [R1-3] Move the container (id: orderSummary) next to the container (id: shippingForm). Summary first.
4. [R1-4] Add a secure-payment badge in the empty area at (x 40, y 1360, 700 × 80), below the "Pay with Apple Pay" button (id: applePayButton).
```

When the agent finishes, it sets the round to `applied` and lists the screens it changed (`review.md` and `AGENTS.md` tell it to). Older rounds stay in the round menu in the top bar, read-only.

### Only changed screens are recaptured

Unchanged screens are copied forward from the previous round, so round 2 of a 7-screen app usually captures one or two. A screen is recaptured when any of these says it may have changed:

- it had instructions in the round the agent just applied;
- the agent listed it in `changedScreens` when it marked the round applied (the `AGENTS.md` section asks for this);
- its flow, setup script or `screens.json` entry changed, or it's new, or it failed last time;
- it loads the same page as a recaptured screen (`/checkout` and `/checkout?error=card`);
- a file matching its `sources` globs changed (optional, see below).

Everything is recaptured when the round added design rules, when the agent reports `"changedScreens": "all"`, when a file in `app.sharedSources` changed, or when files changed and nothing says which screens they affect.

Reused screens are marked `↺ R001` above their tile. Click the badge to recapture that screen, or run `:recapture stale` (or `:recapture all`) in the canvas.

```sh
scribui capture --dry-run      # show what would be captured or reused, and why
scribui capture --all          # recapture everything
scribui capture --screens shop # capture these, reuse the rest
```

For the most precise results, tell ScribUI which code draws which screen:

```json
{
  "app": { "name": "Shop", "platform": "android", "sharedSources": ["app/**/designsystem/**"] },
  "screens": [
    { "id": "shop", "title": "Butik", "flow": "flows/shop.sh", "sources": ["app/**/feature/shop/**"] }
  ]
}
```

### Review on a tablet

Click **▣ tablet** in the canvas's top bar. It shows a QR code with a one-time pairing link (valid for 10 minutes); scan it with the tablet's camera on the same Wi-Fi, or open the link in its browser. Any device with a modern browser works: iPad, Android tablet, Surface. Only the computer running ScribUI can create pairing codes.

Devices stay paired until you click **unpair all** in the same dialog or quit ScribUI. An unpaired device is locked out at once and has to scan a new code.

With a stylus (Apple Pencil, S Pen, Surface Pen) you don't need to pick tools: loops become circles, hooked strokes become arrows, crossings become removals, and short strokes become a handwritten note. Tap the chip to change what a stroke became. Fingers pan and zoom.

### Let the agent drive (MCP)

ScribUI includes an MCP server, so an agent can request reviews and poll for feedback itself. For Claude Code:

```sh
claude mcp add scribui -- scribui mcp
```

Tools: `request_review` (captures a round), `get_feedback` (returns `waiting` or the finished review.md; call it again with `mark_applied: true` when done) and `list_rounds`.

### Troubleshooting

| Problem | Fix |
| --- | --- |
| The canvas doesn't open | ScribUI is already running for this project: `scribui` reopens it. When port 4382 is taken (another program, or ScribUI for another project), ScribUI uses the next free port |
| A screenshot still shows a loading state | ScribUI waits up to 6 s for loaders to disappear. If your app takes longer, wait in the screen's setup script, e.g. `await page.getByTestId('task-card').first().waitFor()` |
| Setup says iOS "requires a Mac" | iOS capture runs the iOS Simulator, which needs a Mac with Xcode. On Windows and Linux, setup lists iOS but asks you to pick Android or Web, and `--platform ios` stops before creating any files. Review the Android or web build instead |
| Android build fails with "requires JVM 17" | ScribUI uses Android Studio's bundled JDK when `JAVA_HOME` is older than 17; install Android Studio, or point `JAVA_HOME` at JDK 17+ |
| Web screens fail with "App not reachable" | start your dev server; check `app.baseUrl` |
| Marks attach to the wrong element | press `E` to show all element outlines, then fix the target via the chip; add testIDs for the long run |
| Chips say `container 632×50` instead of a name | the element has no id or label; add an accessibility id or `data-testid` |
| Mobile capture fails | `scribui doctor --device "iPhone 16"`; check that the simulator is booted and the flow runs with `maestro test <flow>` |
| A screen looks out of date | it was reused (`↺` badge): click the badge, press `R` in the terminal, or run `scribui capture --all` |

## Keyboard reference

A developer tool with a terminal soul: a keyboard-first, monospace interface with a status line and a `:` command line, Swiss type for anything you read, and one orange signal colour for your marks.

| Key | Tool | Gesture |
| --- | --- | --- |
| `L` | board / app | web: switch between the review board and your running app |
| `V` | select | click an element or annotation, drag to pan or move |
| `C` | comment | click to pin, then type |
| `O` | circle | drag a loop around something |
| `A` | arrow | drag start → end; may end on another tile (a flow) |
| `R` | rectangle | drag a box where something should go |
| `X` | remove | click an element to strike it out |
| `P` | draw | free path |
| `U` | rule | shift-click elements on any screens, `⏎`, type a rule |

- **Element layer.** Hover shows the element under the cursor, `alt` walks from child to parent, and `E` shows every outline so you can check capture quality.
- **Resolution chips.** Each mark shows what it resolved to (`button#payButton "Pay now"`). Click a chip to pick the parent, a child or "empty area" instead. Your choice is never overwritten.
- **Inspector.** `notes`, a live `review.md` preview, the element `tree`, and `rules.md`.
- **Pen.** A stylus (Apple Pencil, S Pen, Surface Pen) or drawing tablet turns on pen mode. Loops become circles, hooked lines become arrows, crossings become removals and short strokes become handwriting, and a chip lets you change the result with one tap. Handwriting stays ink: the agent gets a cropped PNG.
- **Live.** The canvas updates when the agent captures a new round or marks one applied.
- **Also:** `⌘Z`/`⌘⇧Z` undo and redo, autosave, `F` fits the board, a double-click focuses a screen, `:theme light` switches theme, `?` lists all keys.

## Commands

| Command | What it does |
| --- | --- |
| `scribui init` | Creates `.scribui/` with an example `screens.json` and adds the agent section to `AGENTS.md` (and `CLAUDE.md` if present) |
| `scribui doctor` | Checks platform tools and devices and prints exact fixes |
| `scribui capture` | Creates a new round: captures the screens that may have changed (screenshot + element tree) and reuses the rest. A failing screen is reported and skipped |
| `scribui open` | Serves the canvas on the latest round (`--lan` pairs a tablet with a one-time QR code) |
| `scribui` | First run: guided setup, then capture and open the canvas. Later: open the canvas on the latest round |
| `scribui status` | Shows the latest round's state and counts |
| `scribui mcp` | MCP server over stdio: `request_review`, `get_feedback` (non-blocking), `list_rounds` |

Flags: `--dir`, `--platform ios|android|web`, `--device`, `--screens a,b`, `--all`, `--dry-run`, `--port` (default 4382), `--no-open`, `--lan`.

**Several devices connected?** Capture asks which one to use. Pass `--device emulator`, a model name such as `--device CPH2791`, or a serial; or set `"device"` under `"app"` in `screens.json` to make the choice permanent.

## Platforms

| Platform | Navigation | Screenshot | Element tree | Needs |
| --- | --- | --- | --- | --- |
| iOS simulator (macOS only) | Maestro flow | `simctl io screenshot` | Maestro hierarchy or `idb ui describe-all` | Xcode, Maestro or idb |
| Android emulator or phone | Maestro flow or adb helper | `adb screencap` | `uiautomator dump` | adb; Maestro optional |
| Web | `url` + optional setup script | Playwright | DOM walk | `playwright` + Chromium |

Ids are taken in this order: accessibility identifier, testID (`data-testid` on web), DOM id, then a stable generated id. On web, `data-component` and `data-source="src/File.tsx:12"` attributes flow into the instructions as source locations.

## The `.scribui/` contract

```
.scribui/
  screens.json          screen manifest, written by the agent
  rules.md              persistent design rules, appended by scribui, editable by hand
  flows/                Maestro flows or setup scripts per screen
  rounds/001/
    review.md           compiled instructions for the agent
    review.json         the same, structured, with element targets
    annotations.json    raw annotations (for re-editing)
    screens/            <id>.png and <id>.annotated.png
    trees/              <id>.json, normalized element tree
    ink/                <annotationId>.png, handwritten notes
    status.json         capturing | open | sent | applied
  latest -> rounds/001
```

Rounds are immutable once sent. JSON Schemas for every file are in [`packages/core/schemas`](packages/core/schemas).

## Development

```sh
pnpm install
pnpm test            # unit + golden-file tests (Vitest)
pnpm test:e2e        # canvas tests in Chromium (Playwright)
pnpm lint && pnpm typecheck
pnpm dev:canvas      # canvas with hot reload; proxies to `scribui open` on :4382
UPDATE_GOLDEN=1 pnpm test   # after an intended change to compiled output
```

| Package | Role |
| --- | --- |
| `packages/core` | Zod schemas, resolver, compiler, SVG rendering, pen gestures. Pure functions with no I/O |
| `packages/capture` | Platform adapters and hierarchy parsers |
| `packages/server` | Hono server, WebSocket, `.scribui/` storage, send/compile/render |
| `packages/canvas` | React + Vite canvas |
| `packages/cli` | `scribui` entry point and MCP server; bundles the others and the built canvas into one npm package |

Thresholds for the resolver and pen gestures live in one object: [`packages/core/src/config.ts`](packages/core/src/config.ts).
