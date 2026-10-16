# ScribUI for Chrome

Send the page you're on to ScribUI's Review: click the ScribUI button, say whether it's
**Our app** (a screen the agent should change) or a **Reference** (the agent takes the look
from it), and press **Send to Review**.

The page goes as Chrome saves a "Webpage, Single File" (MHTML): its HTML with its styles
and images, as it is in your tab, logged in or not. ScribUI renders it offline, so notes
snap to the page's real elements, and the agent gets the snapshot to read exact colours,
fonts and spacing from. By default the extension first scrolls through the page, so images
and content that appear as you scroll are in it.

It finds ScribUI on this computer by itself (the ScribUI app, or `npx scribui`, on ports
4382–4391; add another port in the popup if you started it with `--port`). Nothing leaves
your computer: the page goes from Chrome to the ScribUI running next to it.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** and pick this folder (`packages/extension`).
3. Pin ScribUI from the extensions menu.

Works in Chrome, Edge, Brave, Arc and other Chromium browsers (116 or later).
`pnpm --filter @scribui/extension zip` makes a zip for the Chrome Web Store.

## Permissions

- **activeTab, pageCapture, scripting**: capture the tab you clicked ScribUI on (and scroll
  through it first), only when you click.
- **127.0.0.1 and localhost**: talk to ScribUI on this computer.
- **storage**: remember the last project, extra ports and the scroll setting.
