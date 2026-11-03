# ScribUI for Chrome

Send the page you're on to ScribUI: click the ScribUI button, say whether it's **Our app**
(a screen the agent should change) or a **Reference** (the agent takes the look from it),
and press **Send to ScribUI**. **Open in ScribUI** then shows it in Review: in the desktop
app when that's what runs the project, otherwise in the browser.

The page goes as Chrome saves a "Webpage, Single File" (MHTML): its HTML with its styles
and images, as it is in your tab, logged in or not. ScribUI renders it in a headless Chromium,
so notes snap to the page's real elements, and the agent gets the snapshot to read exact
colours, fonts and spacing from. The page's scripts don't run; fonts, stylesheets and images
the snapshot left out are fetched from the site. By default the extension first scrolls
through the page, so images and content that appear as you scroll are in it.

It finds ScribUI on this computer by itself (the ScribUI app, or `npx scribui`, on ports
4382–4391; add another port in the popup if you started it with `--port`). The page goes
from Chrome to the ScribUI running next to it, never to anywhere else.

Rendering needs Playwright and its Chromium. ScribUI offers to install them when it sets
a project up (or install them yourself: `npm i -D playwright && npx playwright install chromium`);
without them, sending a page fails.

## Install

[Add ScribUI from the Chrome Web Store](https://chromewebstore.google.com/detail/scribui/pchhohneimhmgcfbfkjphfgmfljcopoe), then pin it from the extensions menu.

If you loaded the zip from the v0.2.9 release before it was in the store, remove that copy
in `chrome://extensions`: the two count as different extensions. You only lose the
remembered project and ports.

Works in Chrome, Edge, Brave, Arc and other Chromium browsers (116 or later).

To work on the extension, load this folder (`packages/extension`) unpacked instead.
`pnpm --filter @scribui/extension zip` makes the zip to upload to the Chrome Web Store.

## Permissions

- **activeTab, pageCapture, scripting**: capture the tab you clicked ScribUI on (and scroll
  through it first), only when you click.
- **127.0.0.1 and localhost**: talk to ScribUI on this computer.
- **storage**: remember the last project, extra ports and the scroll setting.
