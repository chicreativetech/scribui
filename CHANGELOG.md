# Changelog

What changed in each release of ScribUI (the desktop app and the `scribui` CLI).
The section for a version becomes its GitHub release notes and what the app's
update dialog shows (see `RELEASING.md`). Write for the people using ScribUI.

## 0.1.0 (unreleased)

The first desktop release.

- **Desktop app for macOS, Windows and Linux.** A projects window, one window per project, and the reviewed web app in its own view: pages that refuse to be embedded work, and captures are exact (sRGB, element bounds matching the old Chrome path).
- **Android device view:** emulators and USB phones live in the app, with mouse, scrolling, typing, rotation and Back/Home; captures check the screen held still and include the on-screen keyboard.
- **iOS Simulator device view (macOS):** the simulator live in the app, with touch, scrolling, hardware-keyboard typing and rotation.
- **Set up a project in the app:** open your app's folder and ScribUI asks what the terminal used to (platform, where the app runs, its id and build command), then waits for your coding agent to list the screens.
- **Installs the capture tools for you:** adb, AXe, Android Studio, Playwright, and fixes Xcode's selection.
- **`scribui` opens the app** when it's installed, and only one ScribUI process writes to a project at a time.
- Updates itself on Windows and Linux (AppImage); on macOS once builds are signed. Crash reports stay on your computer.
