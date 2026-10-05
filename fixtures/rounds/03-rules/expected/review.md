# Design review, round 2

New rules added to rules.md: 2. Unresolved: 0.

App: Grove (sample). Implement every instruction below, in order. Ids are accessibility identifiers, testIDs or DOM ids you can search the code for; bounds are screenshot pixels. Instructions marked [UNRESOLVED] need a question to the user first.

## New rules

- [R2-U1] Primary buttons use the brand green and are 48pt tall. (see rules.md)
- [R2-U2] Inputs always have a visible label above them. (see rules.md)

## Checkout (checkout-default)
Screenshot: screens/checkout-default.annotated.png

1. [R2-1] "4242 4242 4242 4242" input (id: cardInput): Show the card brand icon inside the field.

When done, set `"status": "applied"` in `.scribui/latest/status.json` and add `"changedScreens"`: the ids of every screen whose UI you changed, or `"all"` if you changed shared styles or components. ScribUI then recaptures those screens.
