# intentcue

**Point, don't describe.** Annotate your app's screens and get precise, file-based instructions for your coding agent: Claude Code, Codex, Cursor and others.

```sh
npx intentcue init     # .intentcue/ + agent instructions in AGENTS.md
npx intentcue doctor   # check capture tools
npx intentcue          # capture, then open the canvas
```

Circle, arrow, strike out and comment on real screenshots. Every mark snaps to a real UI element (accessibility id, testID or DOM id). **Send** writes `.intentcue/latest/review.md`; tell your agent: `Implement .intentcue/latest/review.md`.

iOS simulator (Maestro or idb), Android emulator (adb and Maestro), and web (Playwright: `npm i -D playwright && npx playwright install chromium`).

MIT
