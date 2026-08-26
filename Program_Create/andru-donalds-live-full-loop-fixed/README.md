# Andru Donalds Live — Full Loop Ticket Bot

Evidence-backed Python + Playwright ticket assistant for **Andru Donalds Live in Bangkok 2026**.

## Verification levels

- `verification-report.json`: local state-machine fixture results.
- `python3 bot.py --inspect-only`: read the live public page and write evidence without entering a purchase.
- `python3 bot.py --wait-for-window`: keep one Chrome session, enter the normal queue window, respect Retry-After, complete Login from environment/secure prompt, and stop only for CAPTCHA/OTP/payment handoff.
- `./run-full-loop.command`: run the verified browser loop through terms, zone, quantity, event-specific attendee fields, delivery/payment options, and stop on the generated QR page before payment.

Fixture verification does not mean a live queue or checkout was observed. `CHECKOUT_READY` is never emitted without payment-page evidence.

The 2026-08-26 acceptance run verified the existing signed-in profile, selected a live A3 seat, traversed the real booking endpoints, selected pickup plus QR payment, and stopped at ThaiTicketMajor's `payment_kbankqr.php` handoff. No payment was submitted. Live queue entry is still a separate status because no official event was inside its queue window during this verification.

Explicit SOLD OUT and closed-sale pages are handled terminal outcomes with screenshots, not failed Full Loops. A future-day pre-sale returns `PRE_SALE_SCHEDULED` and releases Chrome; only an official sale/queue window within 30 minutes holds the same browser session.

Public inspection does not require Login. A real run must verify either an existing member session or a successful Login-form transition before Checkout. Set `TICKET_USERNAME` and `TICKET_PASSWORD` in the Terminal session or enter them at the secure prompt; the password is never written to config, reports, or memory.

`preferredZones` may be empty when the zone map is not public yet. At runtime the bot reads A/A1/A2-style zones from the authenticated page and asks before selecting; it never silently chooses the first zone. `preferredRows`, `preferredSeatNumbers`, and `seatFallbackMode` control exact/nearest selection while keeping all tickets in the chosen zone.

## Start on macOS

Run `./start.command --inspect-only` first. For an event whose queue opens before sale, set `queueOpenAt` and `saleOpenAt` separately in `config.json`, then launch 10–15 minutes before `queueOpenAt`.
