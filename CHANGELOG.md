# Changelog

What changed in each release of ScribUI (the desktop app and the `scribui` CLI).
The section for a version becomes its GitHub release notes and what the app's
update dialog shows (see `RELEASING.md`). Write for the people using ScribUI.

## 0.2.0 (unreleased)

- **Android and iOS screens are captured by hand,** like web views: open the project in the desktop app, move through your app in the Device tab and press Capture view. Nothing runs through your app on its own any more: setup no longer asks your agent to list screens or write navigation flows, there's no automatic first round, and Recapture is for web projects only. After the agent applies a round, the canvas names the screens it changed so you can capture them again (pick **replace "…"**).
- `scribui` opens Android and iOS projects in the desktop app (and says where to get it when it isn't installed); `scribui capture` and MCP's `request_review` say these screens are captured in the app.
- Projects set up earlier get updated agent instructions in `AGENTS.md` the next time the app opens them.
- A development build of the app keeps its own data, so it runs next to an installed ScribUI.

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
