# Changelog

What changed in each release of ScribUI (the desktop app and the `scribui` CLI).
The section for a version becomes its GitHub release notes and what the app's
update dialog shows (see `RELEASING.md`). Write for the people using ScribUI.

## 0.2.0 (unreleased)

- **Android and iOS screens are captured by hand,** like web views: open the project in the desktop app, move through your app in the Device tab and press Capture view. Nothing runs through your app on its own any more: setup no longer asks your agent to list screens or write navigation flows, there's no automatic first round, and Recapture is for web projects only. After the agent applies a round, the canvas names the screens it changed so you can capture them again (pick **replace "…"**).
- `scribui` opens Android and iOS projects in the desktop app (and says where to get it when it isn't installed); `scribui capture` and MCP's `request_review` say these screens are captured in the app.
- Projects set up earlier get updated agent instructions in `AGENTS.md` the next time the app opens them.
- A development build of the app keeps its own data, so it runs next to an installed ScribUI.
- **Recapture works for web views captured in the App tab:** they're reloaded from their URL, including after the agent applies a round. Anything done on the page before the hand capture (a login, an open menu) isn't repeated. When no view can be captured automatically, Recapture is hidden and the canvas asks you to capture the changed views in the App tab, instead of failing with "nothing to capture".
- **Project windows open maximized** the first time, then the way you last left one: its size and position, maximized or full screen. A window that was on a display that's no longer connected opens on one that is.
- A project starts on the vision board only the first time you open it on round 1; after that it opens on the review board.
- **Vision canvases are A4** (portrait) and centred in the space between the tools and the panels, re-centring when you open or close a panel until you move the view. Drag a canvas's edges or corners to resize it; it stays A4 and never shrinks off what's drawn on it. Canvases from older boards grow to the A4 around them.
- **AI chat:** a Chat button next to Recapture opens a panel where you can prompt the coding agent you already use (Claude Code, Codex, Cursor or any command) without leaving ScribUI. It runs in the project folder and can edit files. It's optional: pick **Just copy prompts** to keep using your terminal. **Send to agent** puts the round's prompt in the chat, and with **Run sent rounds** turned on the agent starts on it right away.

## 0.1.1 (2026-10-07)

The first complete build of the desktop app on all three systems (0.1.0's Windows build didn't finish).

- iOS: captures no longer fail when a system sheet covers the simulator, and a slow simulator list is retried instead of showing no simulators.

## 0.1.0 (2026-10-07)

The first desktop release.

- **Desktop app for macOS, Windows and Linux.** A projects window, one window per project, and the reviewed web app in its own view: pages that refuse to be embedded work, and captures are exact (sRGB, element bounds matching the old Chrome path).
- **Android device view:** emulators and USB phones live in the app, with mouse, scrolling, typing, rotation and Back/Home; captures check the screen held still and include the on-screen keyboard.
- **iOS Simulator device view (macOS):** the simulator live in the app, with touch, scrolling, hardware-keyboard typing and rotation.
- **Set up a project in the app:** open your app's folder and ScribUI asks what the terminal used to (platform, where the app runs, its id and build command), then waits for your coding agent to list the screens.
- **Installs the capture tools for you:** adb, AXe, Android Studio, Playwright, and fixes Xcode's selection.
- **`scribui` opens the app** when it's installed, and only one ScribUI process writes to a project at a time.
- Updates itself on Windows and Linux (AppImage); on macOS once builds are signed. Crash reports stay on your computer.
