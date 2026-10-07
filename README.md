# ScribUI

**Point, don't describe.** A visual review layer between you and your coding agent.

Your agent builds app screens. ScribUI captures them as tiles on a canvas. You circle, strike out, arrow and comment right on the screenshots, and every mark snaps to a real UI element. When you press **Send**, ScribUI writes precise, file-based instructions (`review.md`) that any agent can read: Claude Code, Codex, Cursor and others.

The tool never edits your app and has no AI inside. It supplies context; your agent supplies the intelligence.

```
  capture ──▶ annotate ──▶ send ──▶ agent applies ──▶ capture …
  (ScribUI)   (you)       (ScribUI)  (your agent)
```

## Install

### Desktop app

Download it from [Releases](https://github.com/chicreativetech/scribui/releases): the `.dmg` for macOS (Apple Silicon or Intel), the `.exe` installer for Windows, the `.AppImage` or `.deb` for Linux. Open it, then **Open folder…** your app's folder; ScribUI sets the project up from there (see [The desktop app](#the-desktop-app)).

Builds aren't signed yet, so each system asks once:

- **macOS:** the first launch is blocked; open **System Settings → Privacy & Security** and click **Open Anyway** (or run `xattr -dr com.apple.quarantine /Applications/ScribUI.app`).
- **Windows:** SmartScreen says it protected your PC; click **More info → Run anyway**.
- **Linux:** make the AppImage executable (`chmod +x ScribUI-*.AppImage`), or install the `.deb`.

### Command line

The `scribui` CLI works with or without the app: it sets projects up in the terminal, captures for your agent (`scribui capture`, MCP), and opens projects in the app when it's installed. It's not published to npm yet. Build it from this repo and install it globally:

```sh
git clone <this repo> scribui && cd scribui
pnpm install && pnpm build
cd packages/cli && npm pack && npm install -g ./scribui-*.tgz
scribui --help
```

To use it in one project only, run `npm install -D /path/to/scribui-<version>.tgz` there and call it with `npx scribui`. Node 20 or newer is required.

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

That's the whole interface. The first time, it sets the project up and walks you through the rest; after that it opens the canvas on your latest screens. Android and iOS projects open in the [desktop app](#the-desktop-app), where you capture their screens by hand.

ScribUI looks at the project to decide what it is. A folder without Android or iOS markers is treated as a web app. When it finds a Gradle project, an Xcode project, React Native, Expo or Flutter, it asks which platform to review. To skip the question, pass `--platform web|android|ios`.

| | Web | Android App | iOS App |
| --- | --- | --- | --- |
| Runs on | macOS, Windows, Linux | macOS, Windows, Linux | **macOS only** |
| Captures from | your local dev server | emulator or phone over USB, in the desktop app | iOS Simulator, in the desktop app |
| How screens get captured | by hand in the App tab, and the agent's listed screens automatically | by hand in the Device tab | by hand in the Device tab |
| ScribUI installs for you | Playwright + Chromium | adb (Google's platform tools) | AXe |
| You install yourself | Node 20+ (terminal only) | an emulator (Android Studio) or a phone with USB debugging | Xcode |

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

**What you need:** the ScribUI desktop app, your app's Android build, and an emulator (from Android Studio's Device Manager) or an Android phone with USB debugging on. Works on macOS, Windows and Linux.

Android screens are captured by hand, the way you capture web views: nothing runs through your app on its own.

1. **Open your app's folder in the desktop app** (or run `scribui` there; it hands the project to the app). Setup asks for the platform (Android is preselected for a Gradle, React Native, Expo or Flutter project), confirms the application id and build command it found, and installs adb if it's missing.
2. **Open the Device tab.** It connects to the emulator or phone you used last, or the only one connected, and lists emulators you can start. Install and open your app on it.
3. **Move through your app** with the mouse and keyboard: click to tap, scroll, type, Back, Home, rotate. When a screen is the way you want to review it, **name it and press Capture view**. ScribUI freezes the picture, reads the elements, checks the screen held still, and adds it to the open round and to `screens.json`.
4. **Annotate and Send,** then paste `Implement .scribui/latest/review.md` into your agent.
5. **When the agent is done,** it marks the round applied and lists the screens it changed; the canvas names them. Rebuild and reinstall the app, then capture those screens again in the Device tab, picking **replace "…"** next to Capture view to update a screen in place. Screens you don't capture again are carried forward, marked `↺`.

### iOS App

**What you need:** a Mac with Xcode, at least one iPhone simulator (Xcode → Window → Devices and Simulators), and the ScribUI desktop app. AXe, which shows and controls the simulator, is installed by the app.

> **iOS capture requires a Mac.** ScribUI captures from the iOS Simulator, which Apple only ships with Xcode on macOS, so iOS isn't available on Windows or Linux. Real iPhones aren't supported either. For a React Native, Expo or Flutter app, you can review its Android or web build on Windows and Linux. Layout and copy feedback carries over, but iOS-specific rendering such as fonts, safe areas and native controls won't show.

It works like Android: open the folder in the desktop app (setup confirms the bundle id and build command), boot a simulator from the Device tab's list, move through your app and press **Capture view** for each screen. Typing goes to the simulator as a hardware keyboard in your Mac's layout. After the agent applies a round, rebuild the app and capture the changed screens again with **replace "…"**.

### In the terminal while ScribUI runs

Web projects: `r` recapture changed screens · `R` recapture all screens · `o` open the canvas again (bring back the Chrome window) · `q` quit. Everything else happens in the canvas.

### Several projects at once

Run `scribui` in each project. Each one gets its own canvas on the next free port (4382, 4383, …) in its own browser tab, and its own `.scribui/` folder. Running `scribui` or `scribui open` again in a project that already has a canvas open reopens that canvas instead of starting a second one, also when it was started with `--port`.

### The desktop app

The desktop app does everything the terminal and the browser canvas do, in one window per project, and shows the app you're reviewing live inside it.

- **Setting up a project:** **Open folder…** on a folder that isn't a ScribUI project yet walks you through what `scribui` asks in the terminal: the platform (the detected one is marked), where the web app runs (running dev servers are listed with their page titles) or the mobile app's id and build command, the tools that platform needs, and for mobile, the line to paste into your agent while ScribUI waits for it to list the screens.
- **Installing tools:** the projects window lists the capture tools on your computer and installs the missing ones with **Install**: adb (downloaded from Google), AXe and Android Studio (with Homebrew, or winget on Windows), Playwright, and Xcode's selection when only the Command Line Tools are active. The output shows as it runs.
- **Web:** the **App** tab is your running app as a normal page, so logins, cookies and pages that refuse to be embedded all work. Size it to desktop, laptop, tablet or phone and press **Capture view**.
- **Android and iOS:** mobile projects get a **Device** tab with the emulator, phone or simulator live in it, and it's the only way their screens are captured. Use it with the mouse and keyboard (scrolling, typing, Back/Home, rotate) and press **Capture view**: ScribUI freezes the picture, reads the elements and checks the screen held still. iOS needs a Mac with Xcode, plus AXe.
- **With the CLI:** when the app is installed, `scribui` and `scribui open` open the project in it; `--no-desktop` keeps the browser for web projects. Android and iOS projects always open in the app (without it, `scribui` says where to download it). Only one process captures a project at a time, so the CLI and MCP hand web captures to the app while it has the project open.
- **Updates:** the app checks [Releases](https://github.com/chicreativetech/scribui/releases) when it starts and every few hours. On Windows and with the Linux AppImage it downloads updates and installs them when you quit (or **Help → Restart to Update**). Until macOS builds are signed, and for the `.deb`, it tells you a new version is out and links to it. **Help → Check for Updates…** checks now; what changed is in [CHANGELOG.md](CHANGELOG.md).
- **Crashes:** crash reports stay on your computer. After a crash, the next launch offers to open a GitHub issue with the version and error filled in (you see everything before sending) or to show the files. **Help → Report a Problem…** and **Help → Show Logs and Crash Reports** work any time.

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

### Only changed screens are recaptured (web)

This is about screens your agent lists in `screens.json` for a web app; screens captured by hand (every Android and iOS screen, and web views from the App tab) are only captured again by you. Unchanged screens are copied forward from the previous round, so round 2 of a 7-screen app usually captures one or two. A screen is recaptured when any of these says it may have changed:

- it had instructions in the round the agent just applied;
- the agent listed it in `changedScreens` when it marked the round applied (the `AGENTS.md` section asks for this);
- its setup script or `screens.json` entry changed, or it's new, or it failed last time;
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
  "app": { "name": "Shop", "platform": "web", "baseUrl": "http://localhost:5173", "sharedSources": ["src/design-system/**"] },
  "screens": [
    { "id": "shop", "title": "Shop", "url": "/shop", "sources": ["src/pages/shop/**"] }
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

Tools: `request_review` (web: captures a round; Android and iOS: tells the agent to let you know the app is ready, since you capture those screens yourself), `get_feedback` (returns `waiting` or the finished review.md; call it again with `mark_applied: true` when done) and `list_rounds`.

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
| A mobile capture says "the screen was still changing" | something on screen kept moving (a spinner, an animation, a timer): wait for it, press **Try again**, or **Keep first frame** |
| A screen looks out of date | it was reused (`↺` badge): click the badge, press `R` in the terminal, or run `scribui capture --all` |
| The desktop app's Device tab says a tool is missing | press **Install** there, or in the projects window (**File → Projects…**) |
| The desktop app crashed or misbehaves | **Help → Report a Problem…** opens a prefilled GitHub issue; the logs are under **Help → Show Logs and Crash Reports** |

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
| `scribui capture` | Web: creates a new round, capturing the screens that may have changed (screenshot + element tree) and reusing the rest. A failing screen is reported and skipped. Android and iOS screens are captured in the desktop app instead |
| `scribui open` | Serves the canvas on the latest round (`--lan` pairs a tablet with a one-time QR code) |
| `scribui` | First run: guided setup. Then: open the project (web: the canvas, capturing the first round; Android and iOS: in the desktop app) |
| `scribui status` | Shows the latest round's state and counts |
| `scribui mcp` | MCP server over stdio: `request_review`, `get_feedback` (non-blocking), `list_rounds` |

Flags: `--dir`, `--platform ios|android|web`, `--device`, `--screens a,b`, `--all`, `--dry-run`, `--port` (default 4382), `--no-open`, `--no-desktop`, `--lan`.

**Several devices connected?** Pick one in the desktop app's Device tab; it remembers the last one per project.

## Platforms

| Platform | Navigation | Screenshot | Element tree | Needs |
| --- | --- | --- | --- | --- |
| iOS simulator (macOS only) | by hand, in the Device tab | `simctl io screenshot` | AXe (idb's accessibility tree, web views included) | Xcode, AXe |
| Android emulator or phone | by hand, in the Device tab | `adb screencap` | `uiautomator dump`, plus the on-screen keyboard | adb |
| Web | `url` + optional setup script, or by hand in the App tab | Playwright, or the app's own view | DOM walk | `playwright` + Chromium for automatic captures |

Ids are taken in this order: accessibility identifier, testID (`data-testid` on web), DOM id, then a stable generated id. On web, `data-component` and `data-source="src/File.tsx:12"` attributes flow into the instructions as source locations.

## The `.scribui/` contract

```
.scribui/
  screens.json          screen manifest, written by the agent
  rules.md              persistent design rules, appended by scribui, editable by hand
  flows/                web setup scripts per screen
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
| `packages/project` | Project ownership (lock), the capture queue's runner, saving captured views; shared by the CLI and the desktop app |
| `packages/desktop` | Electron app: projects window and setup, one window per project, the app view and device view, updates and crash reports. `pnpm --filter @scribui/desktop start` runs it from the repo; `dist` packages it. Capture fidelity checks: [`FIDELITY.md`](packages/desktop/FIDELITY.md) |

Releases are version tags built by CI into a draft GitHub release; how to make one, and the signing secrets, are in [RELEASING.md](RELEASING.md).

Thresholds for the resolver and pen gestures live in one object: [`packages/core/src/config.ts`](packages/core/src/config.ts).
