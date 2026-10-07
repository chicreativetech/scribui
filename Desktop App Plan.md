# ScribUI Desktop: plan

A desktop app for macOS, Windows and Linux that shows the app under review live and captures it exactly as it is: the web app on every platform, Android on every platform, and the iOS Simulator on macOS.

*Revised 2026-10-07 after review: spikes for every capture path before any product UI, a project coordinator with a real lock, defined capture timing and fidelity, sessions and capabilities in `LiveTarget`, and estimates treated as prototype numbers until the spikes are done.*

## Approach: one Electron app, not three native ones

Showing the reviewed app correctly doesn't depend on the desktop app being native:

- Web apps are rendered by Chromium. Note the nuance: today the live window uses **your installed Chrome**; Electron ships **its own pinned Chromium**, so captures become accurate to Electron's Chromium version, not to the Chrome you browse with. Usually very close, but it must be stated and tested (see Capture fidelity).
- Android is mirrored with scrcpy and adb, which behave the same on all three systems.
- The iOS Simulator is mirrored by a small Swift helper (`scribui-sim`) built on idb's simulator frameworks as AXe ships them, plus Apple's `simctl` (see Spike I).

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

**iOS Simulator (macOS only).** ~~`idb video-stream`, `idb ui …`~~ (see Spike I): the `scribui-sim` helper streams H.264 from the framebuffer and holds the HID connection; capture with `xcrun simctl io <udid> screenshot` plus the accessibility tree from the helper. On Windows and Linux the option isn't listed.

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
- Don't ship `adb` or AXe: Android's tools come under Google's SDK licence; AXe (MIT) is installed with Homebrew and `scribui-sim` runs on its frameworks. Ship the pinned `scrcpy-server` jar and the `scribui-sim` binary.
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

### Phase 2 results: desktop MVP (2026-10-07)

Code: `packages/desktop/src`: `main.ts` (lifecycle, single instance, links), `projectWindow.ts` (one window per project, canvas IPC), `liveView.ts` + `liveLayout.ts` (the app's `WebContentsView`), `launcherWindow.ts` + `launcher/` (projects window), `menu.ts`, `recent.ts`, `openUrl.ts`, `shellPath.ts`; packaging in `electron-builder.yml`, `scripts/stage-native.mjs`, `.github/workflows/desktop.yml`. Canvas: desktop mode in `Live.tsx`. CLI: `cli/src/desktop.ts`. Tool report: `detectTools` in `capture/src/tools.ts`.

- **Projects window:** recent projects (open, missing, platform, when), "Open folder…", and the device tools with the install command to copy. Opening a project closes it; closing the last project window brings it back. A mobile project opened without its required tool says what's missing and copies the install command.
- **One window per project:** opening an open project focuses its window; a second launch (or link) goes to the running app (single instance).
- **App view (`WebContentsView`):** no preload, sandboxed, its own `persist:app-<hash>` session; http(s) only, new windows go to the system browser. The canvas reports its app tab's free area; dialogs hide the view; toasts move over the status line, one at a time. Back, forward, reload, loading state, and a "didn't load" message when nothing answers. View → Developer Tools for App.
- **Sizes larger than the room:** native views can't be clipped by a parent view or scrolled like the iframe (tested: a child view paints outside its parent's bounds; a view moved off-window stops painting). They're shown scaled down through the page's zoom factor, laid out at exactly the chosen CSS size (zoom and bounds are picked together, since Chromium rounds the zoomed size), and captured at full size: the view is enlarged in place for the shot (~300 ms), then restored.
- **CLI handoff:** with the app installed, `scribui` and `scribui open` open `scribui://open?dir=…` and end once the app owns the project; a first mobile round is followed from the terminal while the app captures it. `--no-desktop` or `SCRIBUI_DESKTOP=0` skips it; `=1` forces it. Links only open projects (never capture or run commands). macOS delivers a launch link as an `open-url` event before the sRGB relaunch, so links are collected and passed on the relaunch's command line.
- **PATH:** apps started from the Dock get a minimal PATH; the app reads the login shell's PATH at startup so Homebrew and SDK tools are found.
- **Packaging:** the main process is one bundle; the only native module (resvg) is staged with the platform binary for each target architecture (fetched with `npm pack` when it isn't installed, e.g. Intel on an Apple Silicon runner), since electron-builder doesn't follow pnpm's layout for optional packages. macOS: ad-hoc signed DMGs for arm64 and x64; Windows: NSIS; Linux: AppImage and `.deb`. CI runs typecheck and tests, then packages on each OS and keeps the builds as artifacts.

Verified on macOS (Apple Silicon), dev and packaged, driven over DevTools: the app view placed on the canvas area; captures in fit and in a scaled 1440×900 (saved 2880×1800 at scale 2, probe pixel-exact in both, sRGB without a profile); a page sending `X-Frame-Options: DENY` shown; back/forward; the load-error state; the projects window in light and dark; open from the list → window, close → projects window back; annotated screenshots rendered in the packaged app (resvg); CLI handoff from a cold start and to the running app, and a repeat `open` finding the owner. 13 new unit tests (layout and exact zoom across sizes, links, recent list, PATH).

**Not verified yet:** the Windows and Linux builds and their link registration (registry, `xdg-mime`); installation from the DMG into /Applications (the handoff was tested with the built app registered in place). *(Correction, phase 5: CI had run; its Linux and Windows packaging failed from the start. Linux is fixed, see phase 5.)*

**Open decision:** the plan limited the app view's navigation to the app's origin(s). Logins that redirect through another origin (OAuth, SSO) would break, so the view allows any http(s) page and blocks other schemes; it has no privileges either way. Narrow it if needed.

### Phase 3 results: Android (2026-10-07)

Code: `capture/src/live/session.ts` (`LiveTarget`, `LiveSession`, capabilities, input and capture types, platform-neutral), `capture/src/live/android.ts` (`AndroidTarget` and its session: device list with states, reconnect), `capture/src/live/androidScreen.ts` (rotation and on-screen keyboard from `dumpsys`); desktop `deviceView.ts` (one session per project window, video to the canvas, capture flow), `deviceInput.ts` (checks every input from the canvas), `scripts/fetch-scrcpy.mjs`; canvas `components/Device.tsx` (the device tab).

- **Device tab:** mobile projects in the desktop app get a "Device" tab (`L`) in place of "App". Picker with emulators, USB phones (unauthorized / offline say why), and "start <AVD>" for emulators that aren't running; it connects to the last device used or the only one connected. Missing adb shows the install command to copy. The screen sits in a device frame, fitted or at 100/75/50 %.
- **Use:** mouse as a finger (one move per frame), wheel and trackpad scrolling (scrcpy's scroll message: i16 fixed point over ±16, 21 bytes, read from the 4.1 sources), typing and paste as text, Enter/Backspace/arrows as keys; Back, Home, Recents, Power and Rotate from the session's capabilities. Rotate flips portrait ↔ landscape and locks it, turning auto-rotate off (as Android's own rotate button does). The main process accepts only well-formed input (points 0–1, known keys, text up to 2,000 characters).
- **Video:** WebCodecs in the canvas; a config packet reconfigures the decoder and is merged into the next key frame, deltas before a key frame are dropped, a decoder error asks the device for a fresh key frame. Frames only go to the canvas while the tab shows; showing it again asks for a key frame. Without a secure context or WebCodecs the tab says so instead of staying black.
- **Capture:** the picture freezes when Capture is pressed; progress (screenshot, elements, checking the screen held still, retrying) with Cancel. Settled: saved, named from the activity in front (`…/.wifi.WifiSettingsActivity` → "Wifi Settings") unless named. Still changing after every try: both frames side by side, "Try again" or "Keep first frame" (saved with the status reason "…element positions may be off"; `unsettled` travels through `POST /api/views` too).
- **Screens that never stop (a running timer, a video, a spinner):** `uiautomator dump` doesn't return a stale tree there, it fails ("could not get idle state", about 10 s a try), so before this the capture failed after six tries (68 s). After two such failures (about 20 s) the capture goes to the same choice with the two frames and says why; keeping it saves the screenshot with only the screen as its tree (notes become regions) and the reason "…it has no elements…". Pausing what moves and trying again gives the elements.
- **Keyboard in the tree (spike A, finding 3):** when `mInputShown=true`, the keyboard's area comes from its window's touchable region (or its frame below the content inset; API 37 prints `frame=`, older releases `mFrame=`, which is why the spike's parser found none). It's added on top as "On-screen keyboard"; app elements it hides are dropped and ones it half hides are cut back. Tested with a mark: around the keyboard it now resolves to the keyboard, where before it resolved to the app's hidden row.
- **Reconnect:** a lost stream shows "reconnecting" over the dimmed last frame and retries for 60 s while adb sees the device (300 ms → 3 s); then "lost" with "Try again".
- **Pinned server:** `fetch-scrcpy.mjs` downloads scrcpy-server 4.1 from the release, checks its SHA-256 (also pinned in the client; the script refuses when they disagree) and its licence into `vendor/` (git-ignored); `start`, `dist` and CI run it, and packaged builds carry both files as resources. `SCRCPY_SERVER` points at another jar for testing.
- **Fixed on the way:** scrcpy's rotate message freezes the new rotation and then thaws auto-rotate again, so with auto-rotate on the sensor turned the screen straight back (and turning auto-rotate off first races with Android applying a stale `user_rotation`): rotation is set with `user_rotation` from the display's actual rotation instead. A failed `ScrcpySession.start` left the server and the `adb forward` behind; the wait for the server is 45 s (a memory-starved emulator took 40 s to start it) and ends at once if the server exits; a session reports live only once the video's size is known.
- `SCRIBUI_DEBUG_DEVICE=<file>` logs the server's output, visibility and key frames (stdout is lost in the sRGB relaunch).

**Verified** on macOS against the Pixel 9a emulator (API 37, cold-booted), driven over DevTools:

| Check | Result |
|---|---|
| Connect, picture in the frame | live in 2.2 s with the last or only device; size known before "live" |
| Mouse | a tap on a Settings row opens it; Back; wheel scrolling (picture matches `screencap` once the fling ends) |
| Settled capture through the button | progress steps shown; saved into R001 as "Settings Homepage" (from the activity) with device, orientation, viewport |
| Keyboard | "wifi" typed through the view lands in the field; the capture's tree has "On-screen keyboard" at 0,1541 1080×883 |
| Capture during swipes | the verify step saw the motion, retried, settled on attempt 2 |
| Stopwatch running | ~23 s; dialog with two different frames and the no-elements text; "Keep first frame" saves it with the reason in status.json |
| Stopwatch paused through the view | settled, 45 elements |
| Rotate button | auto-rotate off, 2424×1080 at 90°, decoder follows (1280×570), landscape capture with a 2424×1080 tree; back to portrait |
| Server killed, 3 times | noticed in ~48 ms, dimmed "reconnecting to Pixel 9a…", live again in ~445 ms; taps work after |
| Packaged app (`electron-builder --dir`, arm64) | jar and licence in Resources, used from there; connects and captures |

18 new unit tests (keyboard and rotation parsing on real API 37 dumps, the tree surgery and the mark, scroll clamping, input checks, device list, text chunks, naming). Typecheck, lint and all 155 tests pass.

While testing, the Mac ran out of memory (16 GB, 14 GB swapped) and the emulator's System UI stopped responding: connects took 15–60 s and the server once took 40 s to start, which is why the wait is now 45 s. Worth a "the device is very slow" hint in the UI later.

**Not verified:** a physical phone over USB (none at hand), and Windows and Linux (CI only). The end-to-end driver was a scratch script; it should become a harness like spike A's, run on CI's Android emulator in phase 5.

### Spike I results (2026-10-07)

Code: `packages/desktop/native/scribui-sim/main.swift` (the helper), `scripts/build-sim-helper.mjs`. Setup: Xcode 26.2, iPhone 17 simulator (iOS 26.3, 1206×2622 @3x), booted headless (no Simulator.app).

**idb isn't the tool any more.** It wasn't installed, its last release predates Xcode 26, and it needs Python. AXe (`cameroncooke/axe`, MIT, active) is a single binary on a maintained fork of idb's frameworks. Its CLI was measured first:

| Path | Result |
|---|---|
| `axe touch` per process | 0.75–1.5 s each (a tap = down + up ≈ 2 s): not usable live |
| `axe batch --stdin` | runs steps only after stdin closes: not a channel |
| `axe stream-video` | "mjpeg" carries PNGs (3 MB/frame, 11 fps); half-scale JPEG 8 fps; BGRA ~29 fps at ~90 MB/s |
| `axe describe-ui` | 0.4–1.3 s; idb's nested JSON (the existing `parseIdb` reads it); **no web-view content** |
| `simctl io screenshot` | 0.38 s, sRGB chunk, no ICC profile (no colour-space problem like Electron's) |

So, as the plan allowed, a small Swift helper the app starts: `scribui-sim serve` links AXe's FBControlCore/FBSimulatorControl, keeps one HID connection and one encoded stream, and talks JSON lines in / framed binary out.

| Check | Result |
|---|---|
| Helper ready (frameworks, simulator, HID) | ~290 ms |
| Tap (down + up) on the open HID connection | 5–7 ms |
| Stream | H.264 Annex B, one write per NAL (SPS/PPS/IDR/P), frames only when the screen changes, as scrcpy: the canvas's WebCodecs decoder is reused unchanged |
| Rotation | the framebuffer (stream and screenshots) **stays portrait**; the UI is drawn sideways in it. The accessibility tree switches to landscape points; the HID still takes portrait points |
| Landscape tap through the mapping (`x = Y, y = H − X` for landscape-left) | hits Safari's address field |
| Web views (Safari, WKWebView) | not in the app's own tree; idb finds them by hit-testing a grid of points (`remoteContentOptions`) |
| Element alignment, magenta probe in Safari | tree bounds = magenta pixels, 0 px, portrait and landscape; a circle around it resolves to it |

**Findings that change the plan**

1. **Build:** AXe's frameworks are prebuilt; compiling against them needs idb's private headers (fetched at the commit AXe 1.8.0 was built from) and a patched copy of FBSimulatorControl's module interface (`FBSimulatorControl.FBFoo` and `IOSurface.IOSurface` don't resolve, a module/type name clash). It then builds with Xcode 26.2's Swift 6.2 although the frameworks came from 6.3. At runtime the helper loads AXe's own frameworks via `@rpath` (Apple Silicon and Intel Homebrew). Universal binary.
2. **Turned screens are turned by ScribUI:** the stream is drawn rotated in the canvas, landscape screenshots are rotated before saving (new `rotatePixels`/`encodePng`), and touches are mapped back to portrait points. Which landscape it is comes from the device orientation ScribUI set; the frontmost app's frame says whether the UI followed (polled every 2 s while turned, ~90 ms a check).
3. **Web content needs a fresh process per tree:** idb remembers the remote elements it found and skips them for the rest of the process (its "seen PIDs" filter), so only the first describe in a process has the page. Captures run `scribui-sim describe` (one-shot, ~1.8 s at a 25 pt grid; 10 pt takes ~10 s for a few more elements). In landscape idb builds the grid from the turned app frame and misses most of the screen: the helper passes the portrait screen as the region. Overlays of the app over a web view (a Safari tip) hide the page from the grid.
4. **Typing must be physical keys:** HID usages are turned into characters by the simulator's hardware keyboard layout (here Swedish, from the Mac), so sending "US key for `-`" typed `+`. The canvas now sends `KeyboardEvent.code` + Shift/Option (`physical` input, capability `physicalKeys`), as Simulator.app does; dead keys compose on the simulator (`´` + `e` → `é`). Pasted text goes through `simctl pbcopy` + Cmd+V (iOS's smart paste may add a space).
5. **No keyboard problem like Android's:** with HID typing iOS treats the keyboard as hardware and shows only its accessory bar; the software keyboard, when shown, is in the tree.

### Phase 4 results: iOS Simulator (2026-10-07)

Code: capture `live/ios.ts` (`IosTarget`, session: reconnect, orientation, wheel → finger drag), `live/iosCapture.ts` (verified capture, turned upright), `live/iosScreen.ts` (orientation math, simctl and profile parsing, HID usages), `live/simHelper.ts` (helper process, NAL → decoder packets), `png.ts` (`encodePng`, `rotatePixels`), `tools.ts` (AXe instead of idb; the CLI's iOS adapter can read trees with AXe too); desktop `deviceView.ts` (iOS target, simulator list, headless boot), packaging (`mac.extraResources`, CI installs AXe and builds the helper); canvas `Device.tsx` (turned video, start list, iOS wording, physical keys).

- **Device tab** for iOS projects (macOS): booted simulators to show, shut-down ones to start (newest iOS first, twins named by version), booted headless with `simctl boot` + `bootstatus`. Missing AXe or helper: the tab shows the install command. Home and Power buttons (no Back/Recents: keys a session doesn't have are dropped in the main process).
- **Use:** mouse as a finger; wheel/trackpad scrolling becomes a finger drag that lifts 120 ms after the wheel stops (iOS flings as usual); physical keys and paste as above; Rotate turns the device portrait ↔ landscape (left).
- **Capture:** the same flow as Android (freeze, progress, verify, "keep first frame"), named after the frontmost app unless named; viewport in points, orientation saved.
- **Fixed on the way (affects Android too):** the canvas's global `L` shortcut (switch tab) ran before its "live view" guard, so typing an `l` into the device switched tabs; key presses the device tab handled are now skipped by the global shortcuts.

**Verified** on macOS (Apple Silicon) against an iPhone 17 simulator, through the real desktop app driven over DevTools and through `IosTarget` directly:

| Check | Result |
|---|---|
| Connect (helper + stream + orientation) | live in 1.2–1.8 s; picture in the device frame |
| Mouse | a click on a web field focuses it |
| Typing through the app | 20 fast digits arrive in order, Backspace × 5 removes 5; Swedish layout: `a - _ b ! ? @ é` typed exactly; `l` stays in the device |
| Capture, portrait | saved into R001 ("Probe page"), probe 0 px off; ~1.6–2.5 s |
| Rotate button | 2622×1206, picture drawn upright; capture saved as landscape 874×402 pt ("Safari"), probe 0 px off |
| Capture during scrolling | verify step saw motion, settled on attempt 2 |
| Marks | a circle around the probe resolves to it on both saved captures |
| Helper killed, 3 times | noticed in 39–81 ms, live again in ~1 s |
| Simulator shut down | "reconnecting"; Start from the list boots it headless and shows it (16 s) |
| Packaged app (`electron-builder --dir`, arm64) | `scribui-sim` in Resources, runs from there (stream and describe) |

11 new unit tests (simctl and profile parsing, orientation mapping incl. the measured landscape tap, landscape tree placement, PNG turning and encoding, NAL grouping, key input checks). Typecheck, lint and all 166 tests pass.

**Not verified:** an iPad simulator, landscape-right and upside-down (mapped, not measured), the Intel build of the helper (built universal, not run), CI's macOS job with AXe (hasn't run), and a native app with a WKWebView (only Safari).

### Phase 5 results: fidelity suite (2026-10-07)

Code: `packages/desktop/src/fidelity/` (`checks.ts` pure checks, `pages.ts` probe pages, `web.ts` in the app, `mobile.ts` for Android and iOS), `FIDELITY.md` (what's checked, how to run, the Windows pass), `.github/workflows/fidelity.yml`.

- **Probe page:** elements filled with pure colours found nowhere else (plain, rotated 12°, sticky header, below the fold), plus a 30 s transition, an infinite animation and a focused field; `/still` without motion (a device's picture can't be frozen, so a moving page rightly never settles), `/moving` with a box gliding for 5 s.
- **Web suite** runs the product path: the canvas's size menu and `__scribuiCapture` against the app's `WebContentsView`, at fit, phone and 1440×900 (larger than the window), compared with the CLI's Playwright adapter at the same CSS size and scale. 39 checks per scale factor (alignment top and scrolled, marks, raw sRGB, frozen animations, pixels and bounds against Playwright).
- **Mobile suite** (Node, no Electron) opens the probe page in Chrome or Safari, then: key frame, portrait and landscape alignment, marks, motion during capture, keyboard (Android), the stream killed mid-capture. 15–16 checks.
- **CI:** web on Linux (xvfb) and macOS at scale 1 and 2, Android on a Linux emulator (API 34, KVM), iOS on a macOS simulator with AXe. Failed checks become annotations; reports and PNGs are artifacts. Each suite has a watchdog that fails with the step it was stuck in.

**Bugs the suite found (fixed):**

1. **Closing a project could hang** (1 run in 4): the server's `close()` waited for connections, and a request in flight at that moment left its keep-alive connection open, so the server, and the project's lock, never closed while the app ran. Now all connections are closed (with a test that hangs without the fix).
2. **iOS: a capture right after a trackpad scroll could be wrong yet "settled":** the synthetic finger still held the page in overscroll, the screen stood still (both screenshots equal), but the accessibility tree leaves out the overscroll: every element 150 pt off. The session now lifts the finger before capturing, and the bounce back shows as motion.
3. **iOS: trees with numeric values crashed the parser** (`AXValue` is a number for scroll bars and sliders in some states): affected the live capture and the CLI's idb/AXe path.
4. **Linux packages never built:** the executable was named after the package (`@scribui/desktop`); now `scribui`. Windows packaging fails too, for a reason the public API doesn't show: the workflow now turns the end of electron-builder's log into annotations.

**Measured** (macOS, Apple Silicon; iPhone 17 simulator iOS 26.3; Pixel 9a emulator API 37):

| Suite | Result |
|---|---|
| web, scale 2 and 1 | 39/39 each, 6 runs in a row after fix 1 (~11 s a run); probes 0 px (rotated 1 px); Electron vs Playwright: 0.11–0.43 % of pixels differ, bounds identical |
| iOS | 15/15, two runs of the final version; plain probes 0 px; rotated 4 px (WebKit's accessibility frames are whole points); moving page: retried, settled on attempt 3 |
| Android | 16/16, two runs; plain probe 0 px; rotated 5 px (Chrome rounds transformed bounds out to whole CSS px); moving page: settled on attempt 2; keyboard in the tree |

**Findings that change the plan**

1. **Browser chrome meets the page's top on phones:** Safari paints a sticky header's colour behind the status bar and side safe areas; Chrome's toolbar shadow covers the top few pixels. Only the header's bottom edge is comparable there. What a user marks is unaffected (the tree is right), but a screenshot of web content on a phone shows more of the header colour than the element.
2. **Tolerances on phones are one point**, not one pixel: whole-point frames (WebKit) and fractional pixel ratios (Chrome, 2.625). Fine for marks; the web path stays at 1 px.
3. **Injected gestures differ from real ones:** scrcpy's wheel scrolls Chrome with no momentum, and a fast synthetic flick didn't fling Chrome; the motion check uses an animated page instead of a gesture.

**Not verified yet:** the CI run of the new workflow (Linux web under xvfb, the Android emulator job, the iOS job on a hosted Mac: the first run will tell), Windows (manual pass described in `FIDELITY.md`), and the Windows packaging failure.

### Phase 6 results: setup in the app (2026-10-07)

Code: desktop `setup.ts` (folder checks, answers, screens state), `installs.ts` (one install per tool, output to whoever asked), `launcherWindow.ts` + `launcherPreload.ts` + `launcher/` (setup screens, Install buttons); capture `install.ts` (`installPlan`, `runInstall`), `zip.ts`, `playwrightStatus` and `installInfo` in `tools.ts`; project `detect.ts` (`detectProject`, `detectDevServers`, `pageTitle`, `reachable`, moved from the CLI); canvas `Device.tsx` (Install in the device tab).

- **A folder that isn't a project opens setup** instead of an error, from "Open folder…", the recent list (its `.scribui` gone), the menu, a second launch and `scribui://` links. The projects window walks through **Platform** (detected one marked; iOS greyed out off a Mac) → **App** (web: dev servers that answer, this folder's own first via `lsof`, with page titles, or a port/URL; mobile: app id and build command from the project) → **Tools** (what the platform needs, with Install) → **Screens** (mobile: the prompt for the agent, then it waits for `screens.json`; "Capture and open" runs the first round when a device or simulator is up). Web projects open straight after Tools. It warns before setting up the home folder, a drive's root or a folder with no app files.
- **The window only names folders the user chose**; the main process checks every answer again (`checkAnswers`: known platform, http(s) URL, app id shape, single-line build command) before `store.init`.
- **Automated installs** (`installPlan` is pure and tested; the window sends only a tool id):

| Tool | macOS | Windows | Linux |
|---|---|---|---|
| adb | Google's platform-tools zip into `~/.scribui/tools` (no package manager, no admin; `findTool` looks there) | same | same |
| Android emulator | `brew install --cask android-studio` | `winget install Google.AndroidStudio` | command to copy (snap needs sudo) |
| Xcode | App Store link; installed but not selected: one password prompt for `xcode-select -s`, licence and first launch | – | – |
| AXe | Homebrew tap (+ `brew trust`, skipped where Homebrew lacks it) | – | – |
| Playwright + Chromium | npm into `~/.scribui/runtime`, outside the project | same | same |

  Output streams into the window (or the device tab), installs can be canceled and stop when the app quits. The CLI's first run installs adb the same way (it used Homebrew only).
- **Device tab:** "The device view needs adb/AXe" now has an Install button.

**Verified** on macOS (Apple Silicon), through the real app driven over DevTools: web setup of a fresh folder (own dev server found first with its title; Playwright found; files created; project window opened); Android setup from a second launch while another project was open (application id and `./gradlew installDebug` found; screens step noticed the agent's `screens.json`; "Capture and open" started round 1 with trigger `desktop` on the running emulator); the projects window with a scratch HOME: Playwright installed from its Install button (npm and the 94 MB Chromium download streamed, row turned green); adb downloaded and unpacked by `runInstall` (executable bits kept, `adb version` runs). 10 new unit tests (zip reader incl. modes and path escapes, install plans per OS, running steps, URL and answer checks, folder warnings, screens state). Typecheck, lint and all 183 tests pass.

**Not verified:** Install for Android Studio, AXe and the Xcode password prompt (machine already has them), Cancel on a live install, the iOS setup path end to end, Windows and Linux (winget, the Windows zip and `adb.exe` replacement), and the light theme of the new screens.

### CI green (2026-10-07)

First fully green run of both workflows (`bf0e642`): typecheck and tests; packaged builds for macOS, Windows and Linux; the web suite on Linux and macOS at scale 1 and 2; Android on the Linux emulator; iOS on a hosted Mac. What it took:

- **Packaging:** `publish: null` in `electron-builder.yml`. With no publish target (no `repository` field), electron-builder put `null` in its publish list and crashed writing update info (`latest-linux.yml`; Windows went green with the same change, its error had been cut off: GitHub keeps 10 annotations per step, so the log's end is now one annotation and the full log an artifact).
- **Web captures hide scrollbars** for the shot (`Emulation.setScrollbarsHidden`, as Playwright does). Where scrollbars take room (Linux, Windows, macOS without a trackpad, including this Mac by now) the page was laid out 15 px narrower and the body stayed in the tree as an extra container, so trees didn't match Playwright's.
- **iOS:** a slow `simctl list` right after boot made `connect` report "no simulator"; it retries with more time and says what simctl returned. The suite waits until Safari has fetched the probe page (a fresh simulator's first Safari launch is slow) and closes first-run tips over it, which hide the page from the accessibility tree.
- **Android suite** removes its `adb reverse` tunnel; leftovers from many runs stopped Chrome's requests from arriving.

### Phase 7 results: release (2026-10-07)

Code: `.github/workflows/release.yml`, `scripts/release.mjs`, `CHANGELOG.md`, `RELEASING.md`; desktop `electron-builder.config.cjs` (replaces the YAML), `build/entitlements.mac.plist`, `scripts/changelog.mjs` + `release-notes.mjs`, `src/updates.ts`, `src/crashes.ts`, Help menu, the projects window's footer.

Decided with the user: build signing now and turn it on with secrets later; releases on GitHub; crash reports stay local.

- **Release = a tag.** `node scripts/release.mjs 0.2.0` sets the desktop and CLI versions, dates the changelog section, commits and tags (no push). The tag's workflow checks tag = app version and that the changelog has notes, creates one draft release first (so the three build jobs upload into it instead of racing), then builds, signs when it can, and uploads installers plus `latest*.yml`. Publishing the draft by hand releases it.
- **Signing switches on by secret** (`RELEASING.md` lists them): macOS Developer ID with hardened runtime (entitlements: JIT, and library validation off for `scribui-sim`, which loads AXe's Homebrew frameworks) and notarisation when the Apple ID secrets are there too; Windows through Azure Trusted Signing. Without secrets: ad-hoc/unsigned as before. The config must be passed explicitly (`--config electron-builder.config.cjs`; electron-builder doesn't find a .cjs on its own).
- **Updates** (electron-updater from GitHub Releases): Windows and AppImage download in the background and install on quit or Help → Restart to Update; a Mac build updates in place only when Developer-ID-signed (checked with `codesign` at launch), otherwise it says a new version is out with the release page; `.deb` the same; development runs don't check. Checks 10 s after launch and every 6 h; the projects window's footer shows the state. Release notes come from the changelog into `latest*.yml` and the update dialog.
- **Crash reports stay local:** Electron's crash reporter without upload, a log (`~/Library/Logs/ScribUI/main.log` on macOS) of main-process exceptions, crashed pages and child processes, and a list of recent crashes. The next launch after a crash offers a prefilled GitHub issue (version, system, last errors; home folders as `~`, kept under 5,000 characters) or the files; Help has Report a Problem… and Show Logs and Crash Reports.
- **Fixed on the way:** `executableName` (phase 5's Linux fix) also renamed the Mac app to `scribui.app`, which the CLI's "is the app installed" check (`/Applications/ScribUI.app`) would have missed; it's Linux-only now.

**Verified** on macOS (Apple Silicon): config resolution unsigned / signed / notarised / Azure (tests); a packaged zip build carries `app-update.yml` (GitHub, chicreativetech/scribui) and `latest-mac.yml` with the changelog notes; the packaged app's background check against GitHub (no published release yet) ends quietly, the footer offering "Check for updates"; a crashed page is recorded and the next launch stops at the report dialog before opening windows. 8 new unit tests (update modes, issue link and its limits, crashes since the last launch, changelog sections, signing config).

**Not verified:** the Release workflow itself (needs a tag: it creates a draft release on the public repo), a real update from one version to the next (needs two published releases; on macOS also a signed build), signing and notarisation (no certificates yet), the update and crash dialogs on Windows and Linux.

### After phase 7: mobile screens captured by hand (2026-10-07)

Decided with the user: Android and iOS work like the web app's views. The emulator, phone or simulator runs in the Device tab, the user moves through the app and presses Capture view; nothing captures on its own.

- **Dropped for mobile:** the agent listing screens with navigation flows (Maestro / the adb helper), the automatic first round, Recapture and "Rebuild & recapture". `captureRound` refuses Android and iOS with one message (`BY_HAND`), so the canvas, `scribui capture` and MCP all say the same; the canvas hides Recapture (`canCapture`/`canRecapture` only for web).
- **Setup:** the desktop setup has three steps for every platform and opens the project at the end; mobile starter manifests list no screens and no flows are written. The CLI hands Android and iOS projects to the desktop app (without it: the download link; with earlier rounds it can still show them in the browser).
- **The agent:** mobile projects get their own `AGENTS.md` section (no `npx scribui capture`, no screen list; still `changedScreens` when applying), refreshed in older projects when the app opens them. After a round is applied the canvas names the changed screens and opens the Device tab.
- **Development runs** use their own data folder ("ScribUI Dev"): with an installed ScribUI running, a dev build used to hand over to it through the single-instance lock and quit.

The capture fidelity suites are unchanged: they test the Device tab's capture path, which is now the only one.

### Then the product

| # | Phase | Result | Prototype estimate |
|---|---|---|---|
| 1 | Coordinator | shared project coordinator, `.scribui/.lock`, serialized capture queue, `saveLiveCapture` split; CLI and MCP moved onto it | 3–4 days |
| 2 | Desktop MVP | projects window, one window per project, chosen web surface, basic tool detection, CLI handoff; **packaged unsigned builds for macOS, Windows and Linux from CI from the start** | 5–7 days |
| 3 | Android | `LiveSession` for Android, device picker and frame, capture flow with progress and preview, reconnect handling | 6–8 days |
| 4 | iOS Simulator | `LiveSession` for iOS, simulator picker and boot (done, with spike I: see above) | 4–5 days |
| 5 | Fidelity suite | the capture-fidelity matrix in CI (Linux and macOS runners, Android emulator on Linux), manual pass on Windows (built, see above; first CI run pending) | 3–4 days |
| 6 | Setup in the app | first-time project setup as screens; automated tool installation (done, see above) | 5–7 days |
| 7 | Release | Mac signing and notarisation, Windows signing, auto-update, release notes, crash reporting (done without accounts, see above) | 3–4 days, plus accounts |
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
- **Install hassle:** iOS needs AXe from a third-party Homebrew tap (current Homebrew asks to trust it); the Android emulator on Windows needs virtualisation enabled.
- **iOS private frameworks:** `scribui-sim` uses idb's FBSimulatorControl, which drives Xcode's private CoreSimulator/SimulatorKit. A new Xcode can break it until AXe (and idb) catch up; the helper is rebuilt against AXe's frameworks and found through them at runtime.
- **Size:** about 120 MB for the app; until Playwright is dropped, automatic web recaptures still download its Chromium.
- **Testing on all systems:** Android emulator on Linux CI and the iOS Simulator on macOS CI can be automated; Windows device testing will be mostly by hand.
