# Design review, round 2

New rules added to rules.md: 0. Unresolved: 1.

App: Grove (sample). Implement every instruction below, in order. Ids are accessibility identifiers, testIDs or DOM ids you can search the code for; bounds are screenshot pixels. Instructions marked [UNRESOLVED] need a question to the user first.

## Cart (cart)
Screenshot: screens/cart.annotated.png

1. [R2-1] Flow: Cart (cart) leads to Checkout (checkout-default) via the "Go to checkout" button (id: checkoutButton). Tapping checkout should open the checkout sheet.
2. [R2-2] Note on the container (id: promoBanner): Too yellow.
3. [R2-3] [UNRESOLVED] Something should slide in from here (see annotated screenshot, marker 3); ask the user.

## Checkout (checkout-default)
Screenshot: screens/checkout-default.annotated.png

4. [R2-4] Move the "Pay now" button (id: payButton) to the area at (x 390, y 1520). Pin it to the bottom.
5. [R2-5] Move the container (id: orderSummary) next to the container (id: shippingForm).

When done, set `"status": "applied"` in `.intentcue/latest/status.json` and add `"changedScreens"`: the ids of every screen whose UI you changed, or `"all"` if you changed shared styles or components. intentcue then recaptures those screens.
