# Design review, round 1

New rules added to rules.md: 0. Unresolved: 0.

App: Grove (sample). Implement every instruction below, in order. Ids are accessibility identifiers, testIDs or DOM ids you can search the code for; bounds are screenshot pixels. Instructions marked [UNRESOLVED] need a question to the user first.

## Checkout (checkout-default)
Screenshot: screens/checkout-default.annotated.png

1. [R1-1] "Pay now" button (id: payButton): Too dominant, make it secondary to the order summary.
2. [R1-2] Remove the "Pay with Apple Pay" button (id: applePayButton).
3. [R1-3] "Shipping" text at (x 74, y 194, 632 × 45): Use sentence case and a larger heading.
4. [R1-4] Move the container (id: orderSummary) next to the container (id: shippingForm). Summary first, then the form.
5. [R1-5] Add a secure-payment badge in the empty area at (x 40, y 1360, 700 × 80), below the "Pay with Apple Pay" button (id: applePayButton).

When done, set `"status": "applied"` in `.intentcue/latest/status.json` and add `"changedScreens"`: the ids of every screen whose UI you changed, or `"all"` if you changed shared styles or components. intentcue then recaptures those screens.
