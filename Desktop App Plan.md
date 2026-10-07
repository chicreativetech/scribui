# ScribUI Desktop: plan

A desktop app for macOS, Windows and Linux that shows the app under review live and captures it exactly as it is: the web app on every platform, Android on every platform, and the iOS Simulator on macOS.

*Revised 2026-10-07 after review: spikes for every capture path before any product UI, a project coordinator with a real lock, defined capture timing and fidelity, sessions and capabilities in `LiveTarget`, and estimates treated as prototype numbers until the spikes are done.*

## Approach: one Electron app, not three native ones

Showing the reviewed app correctly doesn't depend on the desktop app being native:

- Web apps are rendered by Chromium. Note the nuance: today the live window uses **your installed Chrome**; Electron ships **its own pinned Chromium**, so captures become accurate to Electron's Chromium version, not to the Chrome you browse with. Usually very close, but it must be stated and tested (see Capture fidelity).
- Android is mirrored with scrcpy and adb, which behave the same on all three systems.
- The iOS Simulator is mirrored with Apple's `simctl` and Facebook's `idb`, both command-line tools on the Mac.

Electron drives all of this from one codebase and fits the existing React canvas and Node server. Three truly native apps (Swift, C#, GTK) would triple the work without showing anything better. If a later feature needs real Mac code, such as mirroring a physical iPhone, it becomes a small Swift helper the app starts.

## What each platform can show

| | macOS | Windows | Linux |
|---|---|---|---|
| Web app: live, capture | ✓ | ✓ | ✓ |
| Android emulator and USB phones: mirror, control, capture | ✓ | ✓ | ✓ |
| iOS Simulator: mirror, control, capture | ✓ | – | – |
| Physical iPhone | later | – | – |

## Decisions

1. **One platform per project in v1.** `screens.json` has a single `app.platform`; captures from mixed platforms in one project need a data-model change (platform per screen, per-screen device metadata, grouping on the board) that is out of scope for v1. A project that has both a web app and a mobile app uses two ScribUI projects.
2. **Web surface: decided by spike W.** Candidates are Electron's `WebContentsView` and the existing iframe (see Architecture §2). Current lean: `WebContentsView`.
3. **Tablet streaming of mobile devices: deferred.** WebCodecs needs a secure context; `localhost` is secure, but paired tablets use plain HTTP on the LAN. Tablets keep working for review on the board and in Vision; mirroring Android or iOS on a tablet comes later (MJPEG at a lower frame rate, or HTTPS on the LAN).
4. **The `.scribui/` workflow and the agent side stay as they are.** `npx scribui capture`, MCP and the files the agent reads don't change.

## Architecture

### 1. Desktop shell (`packages/desktop`)

- The Electron main process starts the existing server (`startOnFreePort` plus the capture runner from `makeRunner`), one per open project, through the project coordinator (§4). The window loads the canvas from that server, so the canvas, tablet pairing for the board and live updates stay unchanged.
- A recent-projects window and "Open folder…", with one window per project.
- Logins are kept in a separate browser session per project (`persist:` partition), as the per-project Chrome profile does today.
- The `scribui` CLI opens the project in the app when it's installed (for example through a `scribui://open?dir=…` link).

### 2. Web surface and isolation

Two candidates, decided in spike W:

| | `WebContentsView` | iframe (today) |
|---|---|---|
| Pages that refuse embedding (`X-Frame-Options`, CSP `frame-ancestors`), frame-busting scripts | work: the app is a real top-level page | blocked today; stripping the headers in Electron's session helps headers but not frame-busting scripts, and changes the app's own security behaviour |
| Cookies, `SameSite`, service workers, `window.top` checks | behave as in a normal tab | behave as embedded content |
| Canvas UI on top (popovers, toasts, menus) | can't overlap the view; the canvas must keep the view's bounds in sync and keep its own UI beside it | works as now |
| Changes needed | canvas reports the App view's rectangle to the main process; overlays are rearranged | small |

Whichever wins, the boundary between the reviewed app and ScribUI's privileged code is explicit, following Electron's security guidance:

- The reviewed app gets **no preload and no Node access**: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, its own session partition, navigation and new windows limited to the app's origin(s), `webviewTag` off.
- Only the **canvas** gets a preload. It exposes a small, typed API through `contextBridge` (`capture`, `listDevices`, `input`, `setViewBounds`), checks the sender's origin on every IPC call, and never exposes `ipcRenderer` itself.
- The canvas keeps calling `window.__scribuiCapture`, so the browser and desktop versions share code.

### 3. Live targets: sessions and capabilities

`LiveTarget` describes connected sessions with explicit capabilities instead of four bare methods:

```ts
type Capabilities = {
  video: "webcontents" | "h264" | "mjpeg";   // web doesn't produce a video stream
  pointer: boolean;
  text: boolean;
  keys: ("home" | "back" | "recents" | "lock")[];
  rotate: boolean;
  orientation: "portrait" | "landscape" | "auto";
};

interface LiveTarget {
  list(): Promise<DeviceInfo[]>;                       // web, emulators, simulators, USB phones
  connect(deviceId: string, signal: AbortSignal): Promise<LiveSession>;
}

interface LiveSession {
  readonly capabilities: Capabilities;
  readonly size: { width: number; height: number; scale: number; rotation: 0 | 90 | 180 | 270 };
  on(event: "frame" | "resize" | "rotate" | "disconnect" | "error", cb: (e: unknown) => void): () => void;
  /** View coordinates → device pixels, accounting for scale, letterboxing and rotation. */
  toDevice(p: { x: number; y: number }): { x: number; y: number };
  input(ev: InputEvent, signal?: AbortSignal): Promise<void>;
  capture(screen: ScreenEntry, signal: AbortSignal, progress: (p: CaptureProgress) => void): Promise<LiveCapture>;
  dispose(): Promise<void>;
}
```

The device view enables Home, Back, Rotate and text input from `capabilities`, shows reconnecting when a session emits `disconnect`, and cancels a running capture through its `AbortSignal`.

**Web.** The app shows in the chosen web surface. Capture uses DevTools (`Page.captureScreenshot` with `captureBeyondViewport`) plus the existing DOM-walk script, with the same preparation as `captureLiveFrame` today: animations disabled (equivalent of Playwright's `animations: "disabled"`, via CSS and the DevTools animation domain), caret hidden, the ScribUI UI excluded.

**Android (all platforms).** H.264 from scrcpy's server part, decoded with WebCodecs in the canvas; taps, drags and typing through scrcpy's control channel. Capture with `adb exec-out screencap -p` plus `uiautomator dump` (parsed by the existing `parseUiautomator`).

- scrcpy's client/server protocol is internal and changes between releases. Ship one **pinned** `scrcpy-server` version (Apache 2.0) with a client written for exactly that version, and test both together when upgrading.
- Budget for decoder resets (new SPS/PPS after rotation or resolution change), device disconnects and reconnects.

**iOS Simulator (macOS only).** `idb video-stream` (MJPEG first, H.264 if MJPEG is too heavy), input through `idb ui tap/swipe/text/button`, capture with `xcrun simctl io <udid> screenshot` plus `idb ui describe-all`. On Windows and Linux the option isn't listed.

### 4. Project coordinator: one writer per project

Today the running-instance registry (`cli/src/instances.ts`) is discovery, not a lock: two simultaneous launches can start two servers. And one server doesn't mean one writer: CLI and MCP captures call `captureRound` directly.

- Extract a **project coordinator** from the CLI into a shared package used by the desktop app, the CLI and MCP.
- **Lock:** `.scribui/.lock` created exclusively (`O_EXCL`), holding pid, port and start time. Stale locks (process gone) are taken over. The second launcher connects to the owner instead of starting a server.
- **Serialized captures:** every capture (automatic, live web, live mobile, CLI, MCP) goes through one queue in the lock owner. When no server owns the project, the CLI takes the lock for the duration of its capture.
- **Generalize `saveLiveCapture`:** today it requires a web URL and derives the screen path from `baseUrl`. Split it into a platform-neutral part (round selection, carry-forward, manifest upsert, status) and a web-specific part (URL handling). Mobile live captures store device and orientation instead of a URL.

### 5. Capture timing and fidelity

**What "capture" means**

- **Web:** the page at the moment Capture is pressed, with animations frozen and the caret hidden, as today.
- **Mobile:** the frame the user saw when they pressed Capture, verified against the element tree:
  1. Screenshot immediately on press, and freeze that frame as the preview.
  2. Read the element tree (`uiautomator dump` or `idb ui describe-all`).
  3. Take a second screenshot and compare it with the first.
  4. Same: save. Different: show "the screen was still changing" with both frames, and retry until settled or let the user keep the first frame with a warning that element positions may be off.
- The canvas shows progress (capturing, reading elements, verifying) and the preview, and capture can be cancelled.

**Fidelity is measured, not assumed.** A test matrix, run in CI where possible, compares the new capture paths with today's:

- Pixels: fixed Electron/Chromium version vs the Playwright Chromium used today, fixed fonts, viewport sizes (fit, 1440×900, 390×844), device scale factors 1 and 2, each OS.
- **Element alignment:** for every captured element, its bounds drawn on the screenshot match the rendered element (within a pixel), including scrolled pages, sticky headers, transforms and rotated mobile screens.
- Mobile: rotation, capture during an animation or a scroll, keyboard open, and a device disconnecting mid-capture.

### 6. Device view in the canvas

- Device picker: the web app, running emulators and simulators, connected phones, plus "Start emulator/simulator".
- The live screen in a device frame; Back, Home, Rotate and text input shown from the session's capabilities; size and zoom options.
- Pointer coordinates go through `toDevice`, so letterboxing, scaling and rotation map correctly.
- **Capture view** with the progress and preview flow above; disconnected devices show a reconnecting state instead of a frozen image.

### 7. Tools and setup

- **Basic tool detection ships in the first usable build:** adb, the Android emulator, Xcode and idb are found or clearly reported missing, with the exact install command to copy.
- **Automated installation comes later** (phase 6).
- Don't ship `adb` or `idb`: Android's tools come under Google's SDK licence and idb needs Python. Ship only the pinned `scrcpy-server` jar.
- Today's terminal setup questions (platform, app URL, screens) become screens in the app.

## Phases

### Spikes first

Each spike is time-boxed and independent, so one stuck platform doesn't block the others. Each must prove the full loop: **show → interact → capture → place a mark and check it resolves to the correct element**, plus the listed edge cases.

| Spike | Proves | Edge cases | Time box |
|---|---|---|---|
| W: web | Electron window with the server inside; `WebContentsView` vs iframe; DevTools capture including larger-than-window sizes; isolation boundary | pages that refuse embedding, logins, animation during capture, element alignment vs today's Playwright captures | 3 days |
| A: Android | pinned scrcpy stream decoded with WebCodecs, control channel, capture with the verify step | rotation (decoder reset), disconnect and reconnect, capture during animation and scroll, keyboard open | 4 days |
| I: iOS (Mac) | `idb video-stream`, `idb ui` input, capture with the verify step | rotation, simulator restart, capture during animation | 3 days |

**After the spikes, revise this schedule** with what they revealed.

### Spike W results (2026-10-07)

Code: `packages/desktop` (`src/main.ts`, `src/preload.ts`, `src/webCapture.ts`, harness in `src/spike.ts`). Run the harness with `SCRIBUI_SPIKE=1 SCRIBUI_SPIKE_OUT=<dir> npx electron .` from `packages/desktop` after `npx tsup`; it writes `report.json` and PNGs.

Setup: Electron 44.6.0 (Chromium 152.0.7977.130) vs today's path, Playwright driving Chromium 153.0.8010.12; macOS, device scale 2. Test page with a magenta probe, a sticky header, a rotated element, a 30 s transition, an infinite animation and a focused input. Three sizes: fit (1130×737), phone (390×844) and desktop 1440×900, which is larger than the window's free area.

| Check | Result |
|---|---|
| Server inside the app, canvas loaded from it, `window.__scribuiCapture` from the preload | works; the canvas needed one change (the live iframe is named `scribui-live`) |
| Capture through the main process (frame read cross-origin, DevTools screenshot, `captureLiveFrame` and `saveLiveCapture` reused unchanged) | works for all three sizes, including larger than the window (`captureBeyondViewport`) |
| Element tree vs Playwright path | identical: 8/8 elements, 0 px bounds difference |
| Element alignment: probe bounds in the tree vs magenta in the pixels | 0 px in every case |
| A circle drawn around the probe resolves to the probe | yes, every case |
| Animations (Playwright's `animations: "disabled"` reproduced with `getAnimations()`: finite ones finished, infinite ones cancelled) | same result as Playwright |
| Pixels | 0.13–0.52 % differ (constant 6,838 px): the focused input's focus ring (Electron follows the macOS accent colour, `#e59700`; Playwright's headless browser uses Chrome's default `#005fcc`) and text anti-aliasing in the header and the input (Chromium 152 vs 153, GPU vs software raster) |
| Page sending `X-Frame-Options: DENY` / `frame-ancestors 'none'` | iframe: blank. `WebContentsView` in the same window and session: shows and can be screenshotted |
| Frame-busting script (`top.location = self.location`) in the iframe | blocked by Chromium (no user gesture); the canvas stays. The busting page itself stays framed |

**Findings that change the plan**

1. **Colour space.** Without `--force-color-profile=srgb`, Electron's screenshots are stored in the display's colour space (Display P3) with an embedded profile: `#ff00ff` becomes `#ea33f7`, `#00ff00` becomes `#75fb4c`. Colour-managed viewers hide it, but resvg (annotated PNGs) and the agent read the raw values. `app.commandLine.appendSwitch` is too late for this switch; the app relaunches itself once with it on the command line. With it, captures are plain sRGB and the probe is exactly `#ff00ff`. The fidelity suite must compare **raw** PNG values, not colour-managed ones (the first harness run missed this).
2. **Accent colour.** Form controls and focus rings follow the macOS accent colour in Electron (as in the user's own Chrome), not Chrome's default blue. Decide whether captures should be neutral (force the default accent) or match what the user sees; default proposal: match what the user sees, and record the accent in the capture's metadata.
3. **Chromium version.** Electron pins Chromium (152 here) and lags Chrome slightly; text rendering differs at the anti-aliasing level only. Acceptable; record the Chromium version per capture.
4. **Web surface decision: `WebContentsView`.** It shows pages that refuse embedding; the iframe can't. Next step: the canvas reports the App view's rectangle to the main process (`setViewBounds`), the view follows it, and canvas overlays that would sit on top of the app (toasts, popovers) move beside it while the App view is shown. The iframe path stays as the fallback in the browser-based canvas.

### Spike A results (2026-10-07)

Code: `packages/capture/src/live/scrcpy.ts` (scrcpy client written against the 4.1 sources), `packages/capture/src/live/androidCapture.ts` (verified capture), `decodePng`/`pixelDifference` in `packages/capture/src/png.ts`; harness `packages/desktop/src/spikeAndroid.ts`. Run: `SCRIBUI_SPIKE=android npx electron . --force-color-profile=srgb` from `packages/desktop` after `npx tsup`, with one booted device.

Setup: Android emulator `Pixel_9a` image (sdk_gphone16k_arm64, Android 17 / API 37, 1080×2424), Homebrew `scrcpy-server` 4.1, video limited to 1280 px (570×1280), decoded with WebCodecs in an Electron page.

| Check | Result |
|---|---|
| Connect (push server, `adb forward`, sockets, device name, codec) | 380–530 ms |
| Stream decoded with WebCodecs (`avc1.42c029`, Annex B, config packet merged into the next key frame) | works; 0 decoder errors over ~660 frames; main process → painted frame p50 2 ms, p95 3 ms, max 14 ms (scrcpy sends frames only when the screen changes) |
| Control channel: tap a Settings row (finger pointer id, video coordinates) | navigates to it |
| Text input through the control channel | typed text appears in the field and in the tree |
| Capture with the verify step on a still screen | settled on attempt 1 |
| A circle around "Network & internet" resolves to it | yes |
| Capture during a 1.5 s scroll | the second screenshot differed, retried, settled on attempt 2 |
| Rotation | new video session 1280×570, decoder reconfigured, frames continue, 0 errors; landscape capture 2424×1080 with a matching tree |
| Server killed on the device | noticed in ~150 ms; reconnected in 0.4–0.6 s; frames back 0.6–0.9 s after the kill |

**Findings that change the plan**

1. **The secure-context rule bites immediately.** The first harness page was a `data:` URL: no `VideoDecoder`, zero frames, no error. Pages that decode must come from `127.0.0.1`/`localhost` (as the canvas does) or HTTPS. Same rule as the tablet decision; add a startup check that reports `isSecureContext` and WebCodecs support instead of failing silently.
2. **scrcpy 4.x changed the protocol** from what was documented for 3.x: video sizes now come in separate 12-byte session packets (sent again on rotation), and the media flags moved. The client is pinned to `SCRCPY_VERSION = "4.1"`; ship that jar, not whatever is installed.
3. **The keyboard is not in the element tree.** `uiautomator dump` only covers the app's window; the on-screen keyboard (IME, `com.google.android.inputmethod.latin`) is in the screenshot but not the tree, so a mark on the keyboard would resolve to the app element underneath. Fix in phase 3: detect a shown IME (`dumpsys input_method`), read its frame, and add a synthetic `keyboard` element (or an "on-screen keyboard" region) to the tree. Reading the IME frame from `dumpsys window` needs a more robust parser than the spike's (it found none on API 37).
4. **Verify step works and is cheap on still screens** (one extra screenshot); the `maxChange` tolerance (0.2 % of pixels) absorbed a blinking caret. Screens that never settle (spinners) still need the "keep first frame" path in the UI.
5. **Video resolution vs capture resolution.** The live view streams a scaled-down video (570×1280) while captures use `screencap` at full resolution (1080×2424). Input coordinates are mapped video → device pixels; the device view's `toDevice` must use the current session's size, which changes on rotation.
6. **Harness hygiene.** The emulator keeps app state between runs; each step restarts the app it tests. Electron quits when the last window closes, so reports are written before windows close.

**Remaining for spike A:** a physical phone over USB (only the emulator was tested), and a long-running stream (minutes) to check memory and decoder stability. Not blocking phase 3.


### Phase 1 results: coordinator (2026-10-07)

Code: new package `packages/project` (`@scribui/project`): `lock.ts`, `coordinator.ts`, `views.ts`, plus `capture.ts`, `changes.ts`, `runner.ts`, `instances.ts` moved from the CLI and `env.ts` (build environment) from `setup.ts`. Server: `server/src/queue.ts` and the queue in `app.ts`. Capture: `readLiveFrame`, `LIVE_ISOLATE`, `LIVE_RESTORE` in the web adapter.

- **Lock** `.scribui/.lock` (kept out of git by `.scribui/.gitignore`): written to a temp file and hard-linked into place, so taking it is exclusive and never half-written; pid, host, role (`server` or `capture`), app (`cli`, `desktop`, `mcp`), port, start time. A lock whose process is gone is renamed aside and replaced; only one process can take it over. Released on close and on process exit, never when another process has taken it over.
- **One server per project:** `hostProject` takes the lock and starts the server; a second `scribui open`, `scribui` or the desktop app is pointed at the running one. A server waits while a one-off capture holds the project. Servers from before the lock are still found by their port (`findRunning`).
- **One capture queue in the owner:** rounds (canvas, agent-applied, handed over) and single views run one at a time; a second capture is queued instead of refused with 409. `GET /api/capture/jobs/:id` follows a job.
- **`scribui capture` and MCP's `request_review`** hand their capture to the running server (`captureProject`) and follow it, printing progress; with no server they take the lock for the capture and wait for another one-off capture to finish.
- **Views captured by hand** are platform-neutral (`saveCapturedView`: PNG + element tree; web keeps the URL relative to `app.baseUrl`, mobile keeps `device` and `orientation`, new optional `screens.json` fields). They go through the owner's queue: in-process (`server.saveView`), or from another process via `POST /api/views` (the desktop app when the CLI owns the project).
- **Fixed on the way:** the queue started a job before `enqueue` returned, so a capture's code ran before its own job variable existed (`Cannot access 'job' before initialization`). Jobs now get their job passed in and start on the next tick.

Verified: 11 new unit tests (lock, takeover, waiting, hand-over with two concurrent captures, views, `POST /api/views`); the built CLI against a real project (server + second `open` + handed-over capture; capture with the lock while `open` waits; lock gone after stop); the desktop app as owner and as a guest of a CLI-owned project (spike W harness, captures saved through the CLI server's queue, same pixel-exact alignment).

### Then the product

| # | Phase | Result | Prototype estimate |
|---|---|---|---|
| 1 | Coordinator | shared project coordinator, `.scribui/.lock`, serialized capture queue, `saveLiveCapture` split; CLI and MCP moved onto it | 3–4 days |
| 2 | Desktop MVP | projects window, one window per project, chosen web surface, basic tool detection, CLI handoff; **packaged unsigned builds for macOS, Windows and Linux from CI from the start** | 5–7 days |
| 3 | Android | `LiveSession` for Android, device picker and frame, capture flow with progress and preview, reconnect handling | 6–8 days |
| 4 | iOS Simulator | `LiveSession` for iOS, simulator picker and boot | 4–5 days |
| 5 | Fidelity suite | the capture-fidelity matrix in CI (Linux and macOS runners, Android emulator on Linux), manual pass on Windows | 3–4 days |
| 6 | Setup in the app | first-time project setup as screens; automated tool installation | 5–7 days |
| 7 | Release | Mac signing and notarisation, Windows signing, auto-update, release notes, crash reporting | 3–4 days, plus accounts |
| later | | tablet streaming, physical iPhone (Swift helper plus WebDriverAgent), mixed platforms per project, dropping Playwright for automatic web recaptures | |

**Estimates:** the spikes take about 2 weeks. The phases above add up to roughly 6–8 weeks for a working prototype on all three systems. A polished release across three operating systems, with dependable setup, device recovery and updates, realistically takes longer: plan on **10–14 weeks** in total, and re-estimate after the spikes.

## Packaging

- electron-builder: macOS `.dmg` (Apple Silicon and Intel), Windows NSIS installer, Linux AppImage and `.deb`.
- The one native module, `@resvg/resvg-js` (PNG rendering for annotated screenshots and Vision exports), ships prebuilt per platform; unpack it from the asar archive.
- One GitHub Actions job per platform, producing packaged builds from phase 2 on.

## Signing and testing before paying

- **Developing:** running the app from the repo (`electron .`) needs no signing.
- **Packaged builds on your own Mac:** Apple Silicon only needs an ad-hoc signature (identity `-`), which is free. An app you built yourself isn't quarantined, so Gatekeeper doesn't block it.
- **Test builds for a few people:** downloaded builds show an "unidentified developer" warning. Each person opens **System Settings → Privacy & Security → Open Anyway** once, or runs `xattr -dr com.apple.quarantine /Applications/ScribUI.app`.
- **What the Apple Developer fee ($99/year) is for:** a Developer ID certificate plus notarisation, so downloads open without warnings, and auto-update on macOS (Electron's updater there needs a signed app). A free Apple ID only gives a development certificate for your own devices.
- **Windows:** unsigned builds show a SmartScreen "Run anyway" warning; signing costs about $10/month or more (for example Azure Trusted Signing).
- **Linux:** no signing needed.

Suggested order: spikes and phases 1–4 unsigned; pay for signing when handing builds to others.

## Risks

- **Stream latency and decoder recovery:** H.264 via WebCodecs should be fine in Electron's Chromium, but rotation, resolution changes and reconnects need decoder resets. Spike A proves this.
- **scrcpy protocol drift:** internal and versioned; pinned server and client, upgraded together.
- **Capture fidelity:** Electron's Chromium differs from the user's Chrome, and DevTools screenshots must match today's preparation (animations, caret). The fidelity suite measures pixels and element alignment.
- **Mobile capture timing:** the verify step can loop on screens that never settle (spinners, video); the user can keep the first frame with a warning.
- **Web surface trade-off:** `WebContentsView` fixes embedding but complicates canvas overlays; the iframe keeps overlays but keeps the embedding limit.
- **Concurrency:** desktop, CLI and MCP all writing captures; solved by the coordinator, which must handle stale locks and crashes.
- **Install hassle:** `idb` needs Python plus a Homebrew package; the Android emulator on Windows needs virtualisation enabled.
- **Size:** about 120 MB for the app; until Playwright is dropped, automatic web recaptures still download its Chromium.
- **Testing on all systems:** Android emulator on Linux CI and the iOS Simulator on macOS CI can be automated; Windows device testing will be mostly by hand.
