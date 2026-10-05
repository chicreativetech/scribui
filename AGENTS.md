# Agent instructions

<!-- scribui:start -->
## Visual design review

Design feedback lives in `.scribui/`.

- Before any UI work, read `.scribui/rules.md` and follow it.
- When `.scribui/latest/status.json` says `sent`, implement `.scribui/latest/review.md`,
  then set its status to `applied`.
- When you add, remove or change screens, update `.scribui/screens.json`.
- If an instruction is marked `unresolved`, ask the user instead of guessing.
- To request a review, run `npx scribui capture` and tell the user it is ready.
<!-- scribui:end -->
