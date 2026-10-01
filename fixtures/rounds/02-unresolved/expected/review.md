# Design review, round 2

New rules added to rules.md: 0. Unresolved: 1.

App: Grove (sample). Implement every instruction below, in order. Ids are accessibility identifiers, testIDs or DOM ids you can search the code for; bounds are screenshot pixels. Instructions marked [UNRESOLVED] need a question to the user first.

## Cart (cart)
Screenshot: screens/cart.annotated.png

1. [R2-1] Review the "Go to checkout" button (id: checkoutButton); see marker 1.
2. [R2-2] Add the element sketched at marker 2 in the empty area at (x 40, y 1140, 700 × 120), below the "Go to checkout" button (id: checkoutButton).
3. [R2-3] [UNRESOLVED] No comment given (see annotated screenshot, marker 3); ask the user.
4. [R2-4] In the empty area at (x 390, y 1500): Add a recommended-products carousel here.
5. [R2-5] Container (id: promoBanner): Make this much quieter.

When done, set `"status": "applied"` in `.intentcue/latest/status.json` and add `"changedScreens"`: the ids of every screen whose UI you changed, or `"all"` if you changed shared styles or components. intentcue then recaptures those screens.
