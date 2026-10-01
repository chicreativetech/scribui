# Design review, round 2

New rules added to rules.md: 0. Unresolved: 0.

App: Grove (sample). Implement every instruction below, in order. Ids are accessibility identifiers, testIDs or DOM ids you can search the code for; bounds are screenshot pixels. Instructions marked [UNRESOLVED] need a question to the user first.

## Checkout (checkout-default)
Screenshot: screens/checkout-default.annotated.png

1. [R2-1] Handwritten note on the "Pay now" button (id: payButton), see ink/e2.png.
   ![handwritten note R2-1](ink/e2.png)
2. [R2-2] Remove the "Pay with Apple Pay" button (id: applePayButton). Duplicate of Pay now.
3. [R2-3] Container (id: orderSummary): Needs more breathing room.

When done, set `"status": "applied"` in `.intentcue/latest/status.json` and add `"changedScreens"`: the ids of every screen whose UI you changed, or `"all"` if you changed shared styles or components. intentcue then recaptures those screens.
