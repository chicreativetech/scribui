# ScribUI

**Point, don't describe.** Annotate your app's screens and get precise, file-based instructions for your coding agent: Claude Code, Codex, Cursor and others.

```sh
npx scribui init     # .scribui/ + agent instructions in AGENTS.md
npx scribui doctor   # check capture tools
npx scribui          # capture, then open the canvas
```

Circle, arrow, strike out and comment on real screenshots. Every mark snaps to a real UI element (accessibility id, testID or DOM id). **Send** writes `.scribui/latest/review.md`; tell your agent: `Implement .scribui/latest/review.md`.

iOS simulator (Maestro or idb), Android emulator (adb and Maestro), and web (Playwright: `npm i -D playwright && npx playwright install chromium`).

MIT
