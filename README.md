# intentcue

**Point, don't describe.** A visual review layer between you and your coding agent.

Your agent builds app screens. intentcue captures them as tiles on a canvas. You circle, strike out, arrow and comment right on the screenshots, and every mark snaps to a real UI element. When you press **Send**, intentcue writes precise, file-based instructions (`review.md`) that any agent can read: Claude Code, Codex, Cursor and others.

The tool never edits your app and has no AI inside. It supplies context; your agent supplies the intelligence.

```
  capture ──▶ annotate ──▶ send ──▶ agent applies ──▶ capture …
  (intentcue)  (you)       (intentcue) (your agent)
```

## Install

intentcue is not published to npm yet. Build it from this repo and install the CLI globally:

```sh
git clone <this repo> intentcue && cd intentcue
pnpm install && pnpm build
cd packages/cli && npm pack && npm install -g ./intentcue-0.1.0.tgz
intentcue --help
```

To use it in one project only, run `npm install -D /path/to/intentcue-0.1.0.tgz` there and call it with `npx intentcue`. Node 20 or newer is required.

You don't need to install anything else up front: `intentcue` checks for the capture tools it needs and offers to install them.

## Try it on the sample app first

A small web shop with five screens ships in `examples/checkout-web`:

```sh
node examples/checkout-web/server.mjs &          # sample app on http://localhost:5178
intentcue --dir examples/checkout-web            # opens the canvas
```

## How to use it

Start your app the way you always do, then run one command in the project folder:

```sh
intentcue
```

That's the whole interface. The first time, it sets the project up and walks you through the rest; after that it opens the canvas on your latest screens.

### Web app

1. **Start your app locally,** e.g. `npm run dev`.
2. **Run `intentcue`.** It sees this is the first time and:
   - finds your running app (the dev server started from this folder) and asks you to confirm it;
   - creates `.intentcue/` and adds a short "Visual design review" section to `AGENTS.md`;
   - if Playwright is missing, asks *"Install Playwright? (Y/n)"* and installs it with your package manager, plus its Chromium (once).
3. **Paste one line into your coding agent.** intentcue prints it and copies it to your clipboard:

   ```
   List every screen and important state of this app in .intentcue/screens.json, following .intentcue/screens.md. The app runs at http://localhost:5173.
   ```

   intentcue waits and notices when the agent has saved `screens.json` (or press Enter to go on).
4. **The canvas opens** in your browser and the first round is captured, about a second per screen. Screens appear as they're captured.
5. **Annotate** (see below) and press **Send to agent**. Paste the prompt it shows into your agent:

   ```
   Implement .intentcue/latest/review.md
   ```

6. **That's it for the loop:** when the agent marks the review applied, intentcue recaptures the changed screens by itself and the canvas shows the next round. You can also press **↻ Recapture** any time.

Next time, `intentcue` opens straight to the latest round.

### Mobile app (Android or iOS, beta)

1. **Start the emulator or simulator, or connect your phone,** with the app installed. If nothing is running, intentcue offers to start an emulator or boot a simulator.
2. **Run `intentcue`.** It asks *"Which platform? Android"* (the detected one is preselected), then:
   - creates `.intentcue/`, a navigation helper for flows, and the `AGENTS.md` section;
   - checks the capture tools and offers to install what's missing: adb for Android (via Homebrew), Xcode and Maestro for iOS;
   - picks the device (asking when several are connected) and checks the app is installed, offering to build it (`./gradlew installDebug` is detected for Gradle projects).
3. **Paste the same one line into your agent;** it writes `screens.json` plus a small flow per screen that taps its way there.
4. **The canvas opens** and the first round is captured. Mobile capture is slower (roughly 10 s per screen), so the canvas shows progress with placeholders that fill in as each screen arrives.
5. **Annotate and Send,** then paste `Implement .intentcue/latest/review.md` into your agent.
6. **When the agent is done,** the canvas says *"Rebuild and reinstall the app, then recapture."* Press **Rebuild & recapture** (when intentcue knows your build command) or rebuild yourself and press **↻ Recapture**. Only the changed screens are captured, and the canvas shows the next round.

### In the terminal while intentcue runs

`r` recapture · `o` open the canvas again · `q` quit. Everything else happens in the canvas.

### Annotate

Every mark snaps to a real UI element. Press a key to pick a tool:

- **Comment** (`C`): click an element, type what should change, press `⏎`.
- **Circle** (`O`): drag a loop around one or more elements, then optionally type.
- **Remove** (`X`): click an element to strike it out.
- **Arrow** (`A`): drag from an element to where it should go. End on another element ("move it next to this"), on empty space ("move it here"), or on a different screen (a flow between screens).
- **Rectangle** (`R`): draw a box on empty space and type what to add there.
- **Draw** (`P`): a free-form note.
- **Rule** (`U`): click an element and shift-click more, even on other screens. Press `⏎` and type a rule that applies everywhere, like *"Primary buttons are full width"*. Rules go to `rules.md` and apply to all future work, not just this round.

After each mark, the element it attached to flashes, and a chip under the mark names it, e.g. `button#payButton "Pay now"`. When that's wrong, switch to select (`V`), click the chip and pick the parent, a child or "empty area". A yellow chip means intentcue couldn't tell what you meant; press `N` to jump to the next one. Typing into a comment right next to a circle, arrow or remove merges it into that mark.

The **notes** tab lists every mark, and **review.md** shows exactly what the agent will receive, live as you draw. Everything autosaves; `⌘Z` undoes.

### What the agent receives

Sending writes `.intentcue/rounds/<n>/review.md`, a structured `review.json` and annotated screenshots, then locks the round. The dialog first warns about marks without text or a clear target. A review reads like this:

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
intentcue capture --dry-run      # show what would be captured or reused, and why
intentcue capture --all          # recapture everything
intentcue capture --screens shop # capture these, reuse the rest
```

For the most precise results, tell intentcue which code draws which screen:

```json
{
  "app": { "name": "Shop", "platform": "android", "sharedSources": ["app/**/designsystem/**"] },
  "screens": [
    { "id": "shop", "title": "Butik", "flow": "flows/shop.sh", "sources": ["app/**/feature/shop/**"] }
  ]
}
```

### Review on an iPad

Click **▣ iPad** in the canvas's top bar. It shows a QR code with a one-time pairing link (valid for 10 minutes); scan it with the iPad's camera on the same Wi-Fi. Only the computer running intentcue can create pairing codes. With an Apple Pencil you don't need to pick tools: loops become circles, hooked strokes become arrows, crossings become removals, and short strokes become a handwritten note. Tap the chip to change what a stroke became. Fingers pan and zoom.

### Let the agent drive (MCP)

intentcue includes an MCP server, so an agent can request reviews and poll for feedback itself. For Claude Code:

```sh
claude mcp add intentcue -- intentcue mcp
```

Tools: `request_review` (captures a round), `get_feedback` (returns `waiting` or the finished review.md; call it again with `mark_applied: true` when done) and `list_rounds`.

### Troubleshooting

| Problem | Fix |
| --- | --- |
| The canvas doesn't open | intentcue is already running for this project: `intentcue` reopens it. Another program on port 4382 makes intentcue use the next free port |
| Android build fails with "requires JVM 17" | intentcue uses Android Studio's bundled JDK when `JAVA_HOME` is older than 17; install Android Studio, or point `JAVA_HOME` at JDK 17+ |
| Web screens fail with "App not reachable" | start your dev server; check `app.baseUrl` |
| Marks attach to the wrong element | press `E` to show all element outlines, then fix the target via the chip; add testIDs for the long run |
| Chips say `container 632×50` instead of a name | the element has no id or label; add an accessibility id or `data-testid` |
| Mobile capture fails | `intentcue doctor --device "iPhone 16"`; check that the simulator is booted and the flow runs with `maestro test <flow>` |
| A screen looks out of date | it was reused (`↺` badge): click the badge, or `intentcue capture --all` |

## Keyboard reference

A developer tool with a terminal soul: a keyboard-first, monospace interface with a status line and a `:` command line, Swiss type for anything you read, and one orange signal colour for your marks.

| Key | Tool | Gesture |
| --- | --- | --- |
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
- **Pen.** An Apple Pencil or drawing tablet turns on pen mode. Loops become circles, hooked lines become arrows, crossings become removals and short strokes become handwriting, and a chip lets you change the result with one tap. Handwriting stays ink: the agent gets a cropped PNG.
- **Live.** The canvas updates when the agent captures a new round or marks one applied.
- **Also:** `⌘Z`/`⌘⇧Z` undo and redo, autosave, `F` fits the board, a double-click focuses a screen, `:theme light` switches theme, `?` lists all keys.

## Commands

| Command | What it does |
| --- | --- |
| `intentcue init` | Creates `.intentcue/` with an example `screens.json` and adds the agent section to `AGENTS.md` (and `CLAUDE.md` if present) |
| `intentcue doctor` | Checks platform tools and devices and prints exact fixes |
| `intentcue capture` | Creates a new round: captures the screens that may have changed (screenshot + element tree) and reuses the rest. A failing screen is reported and skipped |
| `intentcue open` | Serves the canvas on the latest round (`--lan` pairs a tablet with a one-time QR code) |
| `intentcue` | First run: guided setup, then capture and open the canvas. Later: open the canvas on the latest round |
| `intentcue status` | Shows the latest round's state and counts |
| `intentcue mcp` | MCP server over stdio: `request_review`, `get_feedback` (non-blocking), `list_rounds` |

Flags: `--dir`, `--platform ios|android|web`, `--device`, `--screens a,b`, `--all`, `--dry-run`, `--port` (default 4382), `--no-open`, `--lan`.

**Several devices connected?** Capture asks which one to use. Pass `--device emulator`, a model name such as `--device CPH2791`, or a serial; or set `"device"` under `"app"` in `screens.json` to make the choice permanent.

## Platforms

| Platform | Navigation | Screenshot | Element tree | Needs |
| --- | --- | --- | --- | --- |
| iOS simulator | Maestro flow | `simctl io screenshot` | Maestro hierarchy or `idb ui describe-all` | Xcode, Maestro or idb |
| Android emulator | Maestro flow | `adb screencap` | `uiautomator dump` | adb, Maestro for flows |
| Web | `url` + optional setup script | Playwright | DOM walk | `playwright` + Chromium |

Ids are taken in this order: accessibility identifier, testID (`data-testid` on web), DOM id, then a stable generated id. On web, `data-component` and `data-source="src/File.tsx:12"` attributes flow into the instructions as source locations.

## The `.intentcue/` contract

```
.intentcue/
  screens.json          screen manifest, written by the agent
  rules.md              persistent design rules, appended by intentcue, editable by hand
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
pnpm dev:canvas      # canvas with hot reload; proxies to `intentcue open` on :4382
UPDATE_GOLDEN=1 pnpm test   # after an intended change to compiled output
```

| Package | Role |
| --- | --- |
| `packages/core` | Zod schemas, resolver, compiler, SVG rendering, pen gestures. Pure functions with no I/O |
| `packages/capture` | Platform adapters and hierarchy parsers |
| `packages/server` | Hono server, WebSocket, `.intentcue/` storage, send/compile/render |
| `packages/canvas` | React + Vite canvas |
| `packages/cli` | `intentcue` entry point and MCP server; bundles the others and the built canvas into one npm package |

Thresholds for the resolver and pen gestures live in one object: [`packages/core/src/config.ts`](packages/core/src/config.ts).
