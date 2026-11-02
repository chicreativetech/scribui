# Chrome Web Store listing

What goes in each field of the Developer Dashboard. `pnpm --filter @scribui/extension zip`
makes the upload (this folder isn't in it). Keep this in step with what the extension does.

## Store listing

**Name** (from the manifest): ScribUI

**Summary** (from the manifest's `description`, 132 characters at most):

> Send the page you're on to ScribUI's Review, styles, images and elements included: a screen of your app, or a reference.

**Category:** Developer Tools

**Language:** English

**Description:**

```
Send the page you're on to ScribUI, the visual review layer for your coding agent.

ScribUI turns marks on your app's screens into precise instructions your coding agent (Claude Code, Codex, Cursor or any agent that reads files) can act on. This extension brings pages into it from the browser you already use: your app on localhost, a staging site behind a login, or any site whose look you want.

HOW IT WORKS
1. Open the page and click the ScribUI button.
2. Pick the ScribUI project to send it to. The extension finds ScribUI running on your computer by itself.
3. Say what it is:
   • Our app: a screen of your app. The agent changes it.
   • Reference: from somewhere else. The agent takes the look from it.
4. Press Send to ScribUI, then Open in ScribUI to mark it up in Review.

WHAT IT SENDS
The page as Chrome saves a "Webpage, Single File": its HTML with its styles and images, exactly as it is in your tab, logged in or not. By default it scrolls through the page first, so images and content that appear as you scroll are included. ScribUI draws it with its real elements, so your notes snap to buttons, headings and fields, and your agent can read exact colours, fonts and spacing from it.

PRIVATE BY DESIGN
The page goes from Chrome to ScribUI on your own computer (127.0.0.1) and nowhere else. No accounts, no analytics, no servers of ours. It only captures a tab when you click Send.

YOU NEED
The ScribUI desktop app (macOS, Windows, Linux) or the scribui command line tool (npm install -g scribui), with a project open. Get them at https://github.com/chicreativetech/scribui

Works in Chrome, Edge, Brave, Arc and other Chromium browsers.
```

**Images** (in this folder; real ScribUI on the Grove sample app, `examples/checkout-web`):

- Store icon: `icons/icon-128.png`.
- Screenshots, 1280×800, in this order:
  1. `1-send.png`: the popup over the Grove shop, *Our app* picked.
  2. `2-review.png`: the sent page in Review with four notes, each on its element.
  3. `3-review-md.png`: the same, with the review.md the agent gets.
- Small promo tile, 440×280: `promo-tile-440x280.png`.

**Website:** https://github.com/chicreativetech/scribui
**Support:** https://github.com/chicreativetech/scribui/issues

## Privacy practices

**Single purpose:**

```
Send the page in the current tab to the ScribUI app running on the user's own computer, so the user can mark it up and turn their notes into instructions for their coding agent.
```

**Permission justifications:**

| Permission | Justification |
|---|---|
| `activeTab` | Gives access to the tab the user clicked the ScribUI button on, and only that tab, only after that click. |
| `pageCapture` | Saves that tab as MHTML (HTML, styles and images) with `chrome.pageCapture.saveAsMHTML`, which is the page the extension sends to ScribUI on the user's computer. |
| `scripting` | Runs three short functions in that tab after the user clicks Send: one scrolls through the page and back (optional, so lazy-loaded images are included), one reads its title and width, and one temporarily links the page's script-added stylesheets so the saved copy keeps its styles, removing them right after. |
| `storage` | Remembers the last project the user sent to, ports they added, and whether to scroll first, in `chrome.storage.local`. |
| Host permission `http://127.0.0.1/*`, `http://localhost/*` | Finds the ScribUI app running on the user's own computer (ports 4382–4391 and any the user added) and sends the page to it. No other hosts are contacted. |

**Remote code:** No, I am not using remote code. All JavaScript is in the package.

**Data usage** — tick:

- **Website content** (text, images, the page's HTML). It's handled only to send the page,
  when the user clicks Send, to ScribUI on the same computer; it never reaches us or any
  third party.

Leave every other category unticked (no personal info, health, financial, authentication,
personal communications, location, web history or user activity is collected).

Certify all three:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** `<website address>/privacy.html` (in the scribui-website repo, `dist/privacy.html`).
