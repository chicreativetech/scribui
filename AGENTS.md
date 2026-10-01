# Agent instructions

<!-- intentcue:start -->
## Visual design review

Design feedback lives in `.intentcue/`.

- Before any UI work, read `.intentcue/rules.md` and follow it.
- When `.intentcue/latest/status.json` says `sent`, implement `.intentcue/latest/review.md`,
  then set its status to `applied`.
- When you add, remove or change screens, update `.intentcue/screens.json`.
- If an instruction is marked `unresolved`, ask the user instead of guessing.
- To request a review, run `npx intentcue capture` and tell the user it is ready.
<!-- intentcue:end -->
