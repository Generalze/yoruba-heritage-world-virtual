# Payment provider sandbox setup (optional, manual)

Automated tests NEVER call live provider networks — adapters are tested
against injected transports and signed fixtures. This document describes
the OPTIONAL manual sandbox/test-mode smoke setup an operator may
perform. Never commit sandbox or live keys; `.env` is git-ignored. No
live charges are ever attempted.

Everything defaults to disabled. To smoke-test locally with the mock
provider only (no credentials, no money):

```
PAYMENTS_ENABLED=true
```

The mock provider appears at checkout automatically in development and
is impossible to enable in production.

## Webhook endpoints

Configure these paths in the provider dashboards (with your public
origin in front; for local testing use a tunnel such as your own
reverse proxy — no third-party service is required by the platform):

| Provider | Webhook URL                                                                      |
| -------- | -------------------------------------------------------------------------------- |
| Paystack | `https://<origin>/api/webhooks/paystack`                                         |
| Stripe   | `https://<origin>/api/webhooks/stripe`                                           |
| PayPal   | `https://<origin>/api/webhooks/paypal`                                           |
| Crypto   | `https://<origin>/api/webhooks/crypto` (mock-only until a processor is approved) |

These four exact paths are exempt from browser CSRF and are instead
authenticated by provider signature (Paystack HMAC-SHA512,
Stripe `Stripe-Signature`, PayPal verify-webhook-signature API). An
unsigned request does nothing.

## Paystack (test mode)

1. Create a Paystack account; use the TEST secret key (`sk_test_…`).
2. `.env`:
   ```
   PAYSTACK_ENABLED=true
   PAYSTACK_SECRET_KEY=sk_test_xxx
   PAYSTACK_CURRENCIES=NGN
   ```
3. Dashboard → Settings → API Keys & Webhooks → set the webhook URL.
   The same secret key verifies the `x-paystack-signature` header.
4. Test cards are listed in Paystack's documentation.

## Stripe (test mode)

1. Use the TEST secret key (`sk_test_…`).
2. Dashboard → Developers → Webhooks → add endpoint for the events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`;
   copy the signing secret (`whsec_…`).
3. `.env`:
   ```
   STRIPE_ENABLED=true
   STRIPE_SECRET_KEY=sk_test_xxx
   STRIPE_WEBHOOK_SECRET=whsec_xxx
   STRIPE_CURRENCIES=USD,GBP,EUR
   ```
   Note: only appointments whose snapshot currency is on the allowlist
   will offer Stripe — there is deliberately no automatic FX.

## PayPal (sandbox)

1. developer.paypal.com → create a REST app (sandbox) → client id/secret.
2. Create a webhook for the app (events: `PAYMENT.CAPTURE.COMPLETED`,
   `PAYMENT.CAPTURE.DENIED`) and copy its Webhook ID.
3. `.env`:
   ```
   PAYPAL_ENABLED=true
   PAYPAL_ENV=sandbox
   PAYPAL_CLIENT_ID=xxx
   PAYPAL_CLIENT_SECRET=xxx
   PAYPAL_WEBHOOK_ID=xxx
   PAYPAL_CURRENCIES=USD,GBP,EUR
   ```
4. Pay with a sandbox buyer account. The return page triggers the
   authenticated server-side capture; the webhook reconciles it.

## Crypto

No processor has been approved. `CRYPTO_PROVIDER=mock` is the only
implemented adapter, is development/test-only, and production refuses
to start with it enabled. Do not point `CRYPTO_PROVIDER` at any vendor
name — the platform fails safe rather than inventing an integration.

## Currency allowlists are operator facts

`*_CURRENCIES` values are claims about YOUR merchant account, not about
the provider's global capabilities. A provider is hidden at checkout for
any appointment currency not on its allowlist; prices are never
converted.
