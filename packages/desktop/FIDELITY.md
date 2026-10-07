# Capture fidelity

The desktop app's captures must show the app exactly as it is, with every
element's bounds on the element. The fidelity suites check this against a probe
page: elements filled with pure colours found nowhere else, so the coloured
pixels in a capture can be compared with where the element tree puts them.

CI runs them on every push to `main` (`.github/workflows/fidelity.yml`): the web
suite on Linux and macOS at scale factors 1 and 2, the Android suite on an
emulator on Linux, the iOS suite on a simulator on macOS. Failed checks show
as annotations on the run; `report.json` and the screenshots are artifacts.
Each suite runs once more when it fails. Web and Android failures fail the
run; an iOS failure only adds a warning, because CI's freshly booted simulators
are slow enough that a capture takes ~13 s and idb's web-content scan is
unreliable there. **Run the iOS suite on a Mac before a release** (below).

## What is checked

| Suite | Checks |
|---|---|
| web (`src/fidelity/web.ts`) | at the canvas's sizes (fit, phone 390×844, desktop 1440×900, larger than the window): a plain, a rotated and a sticky probe aligned (≤ 1 px; rotated ≤ 2 px), and after scrolling the sticky header on top and a probe below the fold aligned; a circle around the probe resolves to it; raw sRGB values (#ff00ff, no embedded profile); a 30 s transition captured finished and an infinite animation at rest; the same picture as the CLI's Playwright path (≤ 3 % of pixels differ: text anti-aliasing, focus ring colour) and the same element bounds (≤ 1 px) |
| android, ios (`src/fidelity/mobile.ts`) | the stream delivers a key frame; portrait and landscape captures with the probes aligned (within one point: Chrome lays out at fractional ratios, WebKit gives whole points; rotated elements two points); a circle resolves; a capture while something moves is noticed (retried until settled, or kept as unsettled) and what settles is aligned; Android: the on-screen keyboard is in the tree; the stream killed mid-capture: the capture ends and the session comes back within 10 s |

The sticky header is compared by its bottom edge only on phones: Safari paints
its colour behind the status bar and the side safe areas, and Chrome draws its
toolbar's shadow over its top.

## Running them locally

From `packages/desktop`:

```sh
npx tsup
# web, once per scale factor (the switches skip the app's sRGB relaunch, so output stays in the terminal)
SCRIBUI_FIDELITY=web npx electron . --force-color-profile=srgb --force-device-scale-factor=1
SCRIBUI_FIDELITY=web npx electron . --force-color-profile=srgb --force-device-scale-factor=2

# a booted emulator or USB phone (node scripts/fetch-scrcpy.mjs first)
npx tsx src/fidelity/mobile.ts android [--device <serial>]
# a booted simulator (AXe, node scripts/build-sim-helper.mjs first)
npx tsx src/fidelity/mobile.ts ios [--device <udid>]
```

Each prints its checks and the report's path, and exits 1 when one fails.
`SCRIBUI_FIDELITY_OUT=<dir>` keeps the report and PNGs there;
`SCRIBUI_FIDELITY_MAX_PIXEL_PCT` changes the web suite's pixel threshold.

## The manual pass on Windows

CI doesn't run the suites on Windows (no Android emulator on its runners, and
the web suite's results there need a look the first time). Before a release,
on a Windows PC:

1. **Web suite**, in PowerShell from `packages\desktop` after `npx tsup` and
   `npx playwright install chromium`:
   `$env:SCRIBUI_FIDELITY="web"; npx electron . --force-color-profile=srgb --force-device-scale-factor=1`,
   then the same with `=2` (and at 125 %/150 % display scaling without the
   switch). All checks pass; look at the PNGs in the report's folder.
2. **Android suite** with an emulator (Android Studio, virtualisation on) or a
   phone over USB: `npx tsx src/fidelity/mobile.ts android`. All checks pass.
3. **The installed app** (the NSIS build from CI):
   - installs per user, starts from the Start menu; the projects window shows
     the tools (adb found or the `winget` command to copy);
   - `scribui open` in a project hands over to the app (`scribui://` link registered);
   - a web project: the app tab shows the app at fit, phone and desktop sizes,
     Capture view saves a view whose marks land on the right elements;
   - an Android project: the device tab shows the emulator, mouse, keyboard
     (including a non-US layout) and Back/Home work, Rotate turns it, Capture
     view saves it; unplugging a phone shows "reconnecting";
   - closing the last project window brings the projects window back.

Write down the Windows version, display scaling and results with the release.
