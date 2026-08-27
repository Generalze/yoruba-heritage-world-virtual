import { describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'

import { envSchema } from '@/lib/env'
import {
  decimalStringToMinor,
  minorToDecimalString,
} from '@/providers/payments/money'
import { createPaystackProvider } from '@/providers/payments/paystack'
import { createStripeProvider } from '@/providers/payments/stripe'
import { createPaypalProvider } from '@/providers/payments/paypal'
import {
  buildMockCryptoWebhook,
  createCryptoProvider,
} from '@/providers/payments/crypto'
import { buildMockWebhook, createMockProvider } from '@/providers/payments/mock'
import { PaymentProviderError } from '@/providers/payments/types'
import type {
  AttemptIdentity,
  InitializePaymentInput,
  ProviderTransport,
} from '@/providers/payments/types'

/**
 * Provider adapter unit tests (spec §67–§70). NO live provider network
 * is ever touched: every adapter runs against an injected transport
 * with realistic fixtures. Signature tests operate on exact raw bytes
 * and prove that any body mutation invalidates verification.
 */

const attempt: AttemptIdentity = {
  publicId: '11111111-2222-3333-4444-555555555555',
  idempotencyKey: 'yhwv_test_idem_key_0001',
  amountMinor: 500_000,
  currency: 'NGN',
  providerReference: 'yhwv_test_idem_key_0001',
  providerPaymentId: null,
  providerCheckoutId: null,
}

const initInput: InitializePaymentInput = {
  attempt,
  appointmentPublicId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  userEmail: 'payer@test.local',
  returnUrl: 'http://localhost:3000/payments/return/paystack?attempt=x',
  cancelUrl: 'http://localhost:3000/checkout/x?cancelled=1',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

interface CapturedRequest {
  url: string
  init: RequestInit
}

function captureTransport(
  responses: Array<Response> | ((url: string, init: RequestInit) => Response),
): { transport: ProviderTransport; calls: Array<CapturedRequest> } {
  const calls: Array<CapturedRequest> = []
  const queue = Array.isArray(responses) ? [...responses] : null
  return {
    calls,
    transport: (url, init) => {
      calls.push({ url, init })
      if (queue) {
        const next = queue.shift()
        if (!next) throw new Error('no fixture response left')
        return Promise.resolve(next)
      }
      return Promise.resolve(
        (responses as (url: string, init: RequestInit) => Response)(url, init),
      )
    },
  }
}

// --- money ------------------------------------------------------------------

describe('money conversion (integer only)', () => {
  it('converts minor units to exact decimal strings', () => {
    expect(minorToDecimalString(500_000, 'NGN')).toBe('5000.00')
    expect(minorToDecimalString(1999, 'USD')).toBe('19.99')
    expect(minorToDecimalString(5, 'USD')).toBe('0.05')
    expect(minorToDecimalString(1234, 'JPY')).toBe('1234')
  })

  it('parses decimal strings strictly back to minor units', () => {
    expect(decimalStringToMinor('5000.00', 'NGN')).toBe(500_000)
    expect(decimalStringToMinor('19.99', 'USD')).toBe(1999)
    expect(decimalStringToMinor('19.9', 'USD')).toBe(1990)
    expect(decimalStringToMinor('1234', 'JPY')).toBe(1234)
    expect(decimalStringToMinor('19.999', 'USD')).toBeNull()
    expect(decimalStringToMinor('abc', 'USD')).toBeNull()
    expect(decimalStringToMinor('-5.00', 'USD')).toBeNull()
    expect(decimalStringToMinor('1e3', 'USD')).toBeNull()
  })

  it('rejects non-integer minor amounts', () => {
    expect(() => minorToDecimalString(19.5, 'USD')).toThrow()
    expect(() => minorToDecimalString(-1, 'USD')).toThrow()
  })
})

// --- Paystack (§67) ---------------------------------------------------------

describe('Paystack adapter', () => {
  const config = {
    enabled: true,
    secretKey: 'sk_test_paystack_secret',
    currencies: ['NGN', 'USD'],
  }

  it('initializes from the backend with snapshot amount and minimal metadata', async () => {
    const { transport, calls } = captureTransport([
      jsonResponse({
        status: true,
        data: {
          authorization_url: 'https://checkout.paystack.com/abc123',
          access_code: 'abc123',
          reference: attempt.idempotencyKey,
        },
      }),
    ])
    const provider = createPaystackProvider({ ...config, transport })
    const result = await provider.initializePayment(initInput)
    expect(result.checkoutUrl).toBe('https://checkout.paystack.com/abc123')
    expect(result.providerReference).toBe(attempt.idempotencyKey)

    const body = JSON.parse(String(calls[0].init.body)) as Record<
      string,
      unknown
    >
    expect(calls[0].url).toBe('https://api.paystack.co/transaction/initialize')
    expect(body.email).toBe('payer@test.local')
    expect(body.amount).toBe(500_000)
    expect(body.currency).toBe('NGN')
    expect(body.reference).toBe(attempt.idempotencyKey)
    expect(body.callback_url).toBe(initInput.returnUrl)
    // Metadata minimization (spec §60): exactly the two reconciliation
    // ids — never notes, DOB, phone or spiritual context.
    expect(Object.keys(body.metadata as object).sort()).toEqual([
      'appointmentPublicId',
      'paymentAttemptPublicId',
    ])
  })

  it('maps explicit rejection as non-retryable and 5xx as retryable', async () => {
    const rejected = createPaystackProvider({
      ...config,
      transport: captureTransport([
        jsonResponse({ status: false, message: 'Invalid currency' }, 400),
      ]).transport,
    })
    let thrown: unknown
    try {
      await rejected.initializePayment(initInput)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PaymentProviderError)
    expect((thrown as PaymentProviderError).retryable).toBe(false)

    const flaky = createPaystackProvider({
      ...config,
      transport: captureTransport([jsonResponse({}, 503)]).transport,
    })
    let thrown5xx: unknown
    try {
      await flaky.initializePayment(initInput)
    } catch (error) {
      thrown5xx = error
    }
    expect(thrown5xx).toBeInstanceOf(PaymentProviderError)
    expect((thrown5xx as PaymentProviderError).retryable).toBe(true)
  })

  it('maps duplicate-reference rejection as retryable recovery, never a false failure', async () => {
    const provider = createPaystackProvider({
      ...config,
      transport: captureTransport([
        jsonResponse(
          { status: false, message: 'Duplicate Transaction Reference' },
          400,
        ),
      ]).transport,
    })
    let thrown: unknown = null
    try {
      await provider.initializePayment(initInput)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PaymentProviderError)
    expect((thrown as PaymentProviderError).code).toBe(
      'PAYSTACK_DUPLICATE_REFERENCE',
    )
    expect((thrown as PaymentProviderError).retryable).toBe(true)
  })

  it('maps network failure as retryable (ambiguous, same identity must be reused)', async () => {
    const provider = createPaystackProvider({
      ...config,
      transport: () => Promise.reject(new Error('ECONNRESET')),
    })
    let thrown: unknown
    try {
      await provider.initializePayment(initInput)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PaymentProviderError)
    expect((thrown as PaymentProviderError).retryable).toBe(true)
  })

  it('verifies success by reference with amount/currency/paid_at', async () => {
    const provider = createPaystackProvider({
      ...config,
      transport: captureTransport([
        jsonResponse({
          status: true,
          data: {
            status: 'success',
            reference: attempt.idempotencyKey,
            id: 987654,
            amount: 500_000,
            currency: 'NGN',
            paid_at: '2026-08-08T10:15:30.000Z',
          },
        }),
      ]).transport,
    })
    const verified = await provider.verifyPayment(attempt)
    expect(verified.outcome).toBe('SUCCEEDED')
    expect(verified.amountMinor).toBe(500_000)
    expect(verified.currency).toBe('NGN')
    expect(verified.providerReference).toBe(attempt.idempotencyKey)
    expect(verified.paidAtSql).toBe('2026-08-08 10:15:30')
  })

  it('maps unsuccessful transactions without inventing success', async () => {
    const provider = createPaystackProvider({
      ...config,
      transport: captureTransport([
        jsonResponse({
          status: true,
          data: {
            status: 'failed',
            reference: attempt.idempotencyKey,
            id: 987655,
            amount: 500_000,
            currency: 'NGN',
            gateway_response: 'Declined',
          },
        }),
      ]).transport,
    })
    const verified = await provider.verifyPayment(attempt)
    expect(verified.outcome).toBe('FAILED')
    expect(verified.failureMessage).toBe('Declined')
  })

  function signedPaystackWebhook(payload: unknown, secret: string) {
    const rawBody = new TextEncoder().encode(JSON.stringify(payload))
    const signature = createHmac('sha512', secret).update(rawBody).digest('hex')
    return { rawBody, headers: { 'x-paystack-signature': signature } }
  }

  const chargeSuccess = {
    event: 'charge.success',
    data: {
      id: 111222,
      status: 'success',
      reference: attempt.idempotencyKey,
      amount: 500_000,
      currency: 'NGN',
      paid_at: '2026-08-08T10:15:30.000Z',
    },
  }

  it('accepts a valid webhook signature over exact raw bytes', async () => {
    const provider = createPaystackProvider(config)
    const { rawBody, headers } = signedPaystackWebhook(
      chargeSuccess,
      config.secretKey,
    )
    const result = await provider.parseAndVerifyWebhook(rawBody, headers)
    expect(result.ok).toBe(true)
    expect(result.relevant).toBe(true)
    expect(result.eventKey).toBe('charge.success:111222')
    expect(result.verified?.outcome).toBe('SUCCEEDED')
    expect(result.verified?.amountMinor).toBe(500_000)
  })

  it('rejects an invalid signature and a missing signature', async () => {
    const provider = createPaystackProvider(config)
    const { rawBody } = signedPaystackWebhook(chargeSuccess, config.secretKey)
    const bad = await provider.parseAndVerifyWebhook(rawBody, {
      'x-paystack-signature': 'deadbeef'.repeat(16),
    })
    expect(bad.ok).toBe(false)
    const missing = await provider.parseAndVerifyWebhook(rawBody, {})
    expect(missing.ok).toBe(false)
  })

  it('rejects a mutated raw body (regression: byte-exact verification)', async () => {
    const provider = createPaystackProvider(config)
    const { rawBody, headers } = signedPaystackWebhook(
      chargeSuccess,
      config.secretKey,
    )
    // Simulate parse→re-stringify drift: a single byte changes.
    const mutated = new Uint8Array(rawBody)
    mutated[mutated.length - 2] = 32
    const result = await provider.parseAndVerifyWebhook(mutated, headers)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('invalid_signature')
  })

  it('marks non-charge events irrelevant (recorded as IGNORED upstream)', async () => {
    const provider = createPaystackProvider(config)
    const { rawBody, headers } = signedPaystackWebhook(
      { event: 'subscription.create', data: { id: 5 } },
      config.secretKey,
    )
    const result = await provider.parseAndVerifyWebhook(rawBody, headers)
    expect(result.ok).toBe(true)
    expect(result.relevant).toBe(false)
  })
})

// --- Stripe (§68) -----------------------------------------------------------

describe('Stripe adapter', () => {
  const config = {
    enabled: true,
    secretKey: 'sk_test_stripe_secret',
    webhookSecret: 'whsec_test_secret',
    currencies: ['USD', 'GBP', 'EUR'],
  }
  const usdAttempt: AttemptIdentity = {
    ...attempt,
    currency: 'USD',
    amountMinor: 12_500,
  }

  it('creates a hosted Checkout Session with exact snapshot amount and idempotency key', async () => {
    const { transport, calls } = captureTransport([
      jsonResponse({
        id: 'cs_test_123',
        url: 'https://checkout.stripe.com/c/pay/cs_test_123',
        status: 'open',
        payment_status: 'unpaid',
        payment_intent: null,
      }),
    ])
    const provider = createStripeProvider({ ...config, transport })
    const result = await provider.initializePayment({
      ...initInput,
      attempt: usdAttempt,
    })
    expect(result.providerCheckoutId).toBe('cs_test_123')
    expect(result.checkoutUrl).toContain('checkout.stripe.com')

    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBe(usdAttempt.idempotencyKey)
    const body = String(calls[0].init.body)
    const params = new URLSearchParams(body)
    expect(params.get('mode')).toBe('payment')
    expect(params.get('line_items[0][price_data][currency]')).toBe('usd')
    expect(params.get('line_items[0][price_data][unit_amount]')).toBe('12500')
    expect(params.get('metadata[paymentAttemptPublicId]')).toBe(
      usdAttempt.publicId,
    )
    // No Adaptive Pricing / automatic conversion is ever requested.
    expect(body).not.toContain('adaptive_pricing')
    expect(body).not.toContain('currency_conversion')
    // No spiritual context in anything sent to Stripe.
    expect(body).not.toContain('spiritual')
    expect(body).not.toContain('deity')
  })

  function signedStripeWebhook(
    payload: unknown,
    secret: string,
    timestampSeconds: number,
  ) {
    const rawBody = new TextEncoder().encode(JSON.stringify(payload))
    const signedPayload = Buffer.concat([
      Buffer.from(`${timestampSeconds}.`, 'utf8'),
      Buffer.from(rawBody),
    ])
    const signature = createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex')
    return {
      rawBody,
      headers: {
        'stripe-signature': `t=${timestampSeconds},v1=${signature}`,
      },
    }
  }

  const nowMs = Date.UTC(2026, 7, 8, 12, 0, 0)
  const completedEvent = {
    id: 'evt_test_1',
    type: 'checkout.session.completed',
    created: Math.floor(nowMs / 1000),
    data: {
      object: {
        id: 'cs_test_123',
        payment_status: 'paid',
        status: 'complete',
        payment_intent: 'pi_test_1',
        amount_total: 12_500,
        currency: 'usd',
        client_reference_id: usdAttempt.publicId,
        metadata: { paymentAttemptPublicId: usdAttempt.publicId },
      },
    },
  }

  it('verifies a valid Stripe-Signature and normalizes completed sessions', async () => {
    const provider = createStripeProvider(config)
    const { rawBody, headers } = signedStripeWebhook(
      completedEvent,
      config.webhookSecret,
      Math.floor(nowMs / 1000),
    )
    const result = await provider.parseAndVerifyWebhook(rawBody, headers, nowMs)
    expect(result.ok).toBe(true)
    expect(result.eventKey).toBe('evt_test_1')
    expect(result.verified?.outcome).toBe('SUCCEEDED')
    expect(result.verified?.amountMinor).toBe(12_500)
    expect(result.verified?.currency).toBe('USD')
    expect(result.verified?.attemptPublicId).toBe(usdAttempt.publicId)
  })

  it('rejects invalid signatures, mutated bodies and stale timestamps', async () => {
    const provider = createStripeProvider(config)
    const timestamp = Math.floor(nowMs / 1000)
    const { rawBody, headers } = signedStripeWebhook(
      completedEvent,
      config.webhookSecret,
      timestamp,
    )

    const wrongSecret = signedStripeWebhook(
      completedEvent,
      'whsec_wrong',
      timestamp,
    )
    const invalid = await provider.parseAndVerifyWebhook(
      wrongSecret.rawBody,
      wrongSecret.headers,
      nowMs,
    )
    expect(invalid.ok).toBe(false)
    expect(invalid.reason).toBe('invalid_signature')

    const mutated = new Uint8Array(rawBody)
    mutated[mutated.length - 2] = 32
    const mutatedResult = await provider.parseAndVerifyWebhook(
      mutated,
      headers,
      nowMs,
    )
    expect(mutatedResult.ok).toBe(false)

    const stale = await provider.parseAndVerifyWebhook(
      rawBody,
      headers,
      nowMs + 3_600_000,
    )
    expect(stale.ok).toBe(false)
    expect(stale.reason).toBe('timestamp_outside_tolerance')
  })

  it('maps failed/expired session events without overwriting logic', async () => {
    const provider = createStripeProvider(config)
    const failedEvent = {
      ...completedEvent,
      id: 'evt_test_2',
      type: 'checkout.session.async_payment_failed',
      data: {
        object: {
          ...completedEvent.data.object,
          payment_status: 'unpaid',
          status: 'complete',
        },
      },
    }
    const { rawBody, headers } = signedStripeWebhook(
      failedEvent,
      config.webhookSecret,
      Math.floor(nowMs / 1000),
    )
    const result = await provider.parseAndVerifyWebhook(rawBody, headers, nowMs)
    expect(result.verified?.outcome).toBe('FAILED')

    const expiredEvent = {
      ...completedEvent,
      id: 'evt_test_3',
      type: 'checkout.session.expired',
      data: {
        object: {
          ...completedEvent.data.object,
          payment_status: 'unpaid',
          status: 'expired',
        },
      },
    }
    const expired = signedStripeWebhook(
      expiredEvent,
      config.webhookSecret,
      Math.floor(nowMs / 1000),
    )
    const expiredResult = await provider.parseAndVerifyWebhook(
      expired.rawBody,
      expired.headers,
      nowMs,
    )
    expect(expiredResult.verified?.outcome).toBe('EXPIRED')
  })

  it('scales Stripe special-case currencies (UGX) both directions — never a 1/100 charge', async () => {
    // ISO/our ledger: UGX is zero-decimal (5000 minor = 5000 shillings).
    // Stripe represents UGX as two-decimal, so the session must carry
    // 500000 and verification must normalize back to ISO minor units.
    const { transport, calls } = captureTransport([
      jsonResponse({
        id: 'cs_ugx_1',
        url: 'https://checkout.stripe.com/c/pay/cs_ugx_1',
        status: 'open',
        payment_status: 'unpaid',
      }),
    ])
    const provider = createStripeProvider({
      ...config,
      currencies: ['UGX'],
      transport,
    })
    await provider.initializePayment({
      ...initInput,
      attempt: { ...attempt, currency: 'UGX', amountMinor: 5000 },
    })
    const params = new URLSearchParams(String(calls[0].init.body))
    expect(params.get('line_items[0][price_data][unit_amount]')).toBe('500000')

    const ugxEvent = {
      id: 'evt_ugx_1',
      type: 'checkout.session.completed',
      created: Math.floor(nowMs / 1000),
      data: {
        object: {
          id: 'cs_ugx_1',
          payment_status: 'paid',
          status: 'complete',
          amount_total: 500_000,
          currency: 'ugx',
          client_reference_id: attempt.publicId,
        },
      },
    }
    const { rawBody, headers } = signedStripeWebhook(
      ugxEvent,
      config.webhookSecret,
      Math.floor(nowMs / 1000),
    )
    const verifier = createStripeProvider({ ...config, currencies: ['UGX'] })
    const result = await verifier.parseAndVerifyWebhook(rawBody, headers, nowMs)
    expect(result.verified?.amountMinor).toBe(5000)
    expect(result.verified?.currency).toBe('UGX')

    // A non-scalable Stripe amount is reported as null → the settlement
    // layer records AMOUNT_MISMATCH review instead of guessing.
    const oddEvent = {
      ...ugxEvent,
      id: 'evt_ugx_2',
      data: {
        object: { ...ugxEvent.data.object, amount_total: 500_050 },
      },
    }
    const odd = signedStripeWebhook(
      oddEvent,
      config.webhookSecret,
      Math.floor(nowMs / 1000),
    )
    const oddResult = await verifier.parseAndVerifyWebhook(
      odd.rawBody,
      odd.headers,
      nowMs,
    )
    expect(oddResult.verified?.amountMinor).toBeNull()
  })

  it('scales ISK exactly like UGX (Stripe charge special case) — both directions', async () => {
    // Platform/ISO: 5 ISK is amountMinor = 5 (zero-decimal). Stripe's
    // charge API represents ISK as two-decimal with trailing 00.
    const { transport, calls } = captureTransport([
      jsonResponse({
        id: 'cs_isk_1',
        url: 'https://checkout.stripe.com/c/pay/cs_isk_1',
        status: 'open',
        payment_status: 'unpaid',
      }),
    ])
    const provider = createStripeProvider({
      ...config,
      currencies: ['ISK'],
      transport,
    })
    await provider.initializePayment({
      ...initInput,
      attempt: { ...attempt, currency: 'ISK', amountMinor: 5 },
    })
    const params = new URLSearchParams(String(calls[0].init.body))
    expect(params.get('line_items[0][price_data][unit_amount]')).toBe('500')

    const iskEvent = {
      id: 'evt_isk_1',
      type: 'checkout.session.completed',
      created: Math.floor(nowMs / 1000),
      data: {
        object: {
          id: 'cs_isk_1',
          payment_status: 'paid',
          status: 'complete',
          amount_total: 500,
          currency: 'isk',
          client_reference_id: attempt.publicId,
        },
      },
    }
    const verifier = createStripeProvider({ ...config, currencies: ['ISK'] })
    const { rawBody, headers } = signedStripeWebhook(
      iskEvent,
      config.webhookSecret,
      Math.floor(nowMs / 1000),
    )
    const result = await verifier.parseAndVerifyWebhook(rawBody, headers, nowMs)
    expect(result.verified?.amountMinor).toBe(5)
    expect(result.verified?.currency).toBe('ISK')

    // Not divisible by 100 → null → AMOUNT_MISMATCH review, no guess.
    const oddEvent = {
      ...iskEvent,
      id: 'evt_isk_2',
      data: { object: { ...iskEvent.data.object, amount_total: 550 } },
    }
    const odd = signedStripeWebhook(
      oddEvent,
      config.webhookSecret,
      Math.floor(nowMs / 1000),
    )
    const oddResult = await verifier.parseAndVerifyWebhook(
      odd.rawBody,
      odd.headers,
      nowMs,
    )
    expect(oddResult.verified?.amountMinor).toBeNull()
  })

  it('never scales ordinary two-decimal currencies (USD unchanged; HUF/TWD are payout-only special cases)', async () => {
    for (const currency of ['USD', 'HUF', 'TWD']) {
      const { transport, calls } = captureTransport([
        jsonResponse({
          id: `cs_${currency}_1`,
          url: 'https://checkout.stripe.com/x',
          status: 'open',
          payment_status: 'unpaid',
        }),
      ])
      const provider = createStripeProvider({
        ...config,
        currencies: [currency],
        transport,
      })
      await provider.initializePayment({
        ...initInput,
        attempt: { ...attempt, currency, amountMinor: 12_500 },
      })
      const params = new URLSearchParams(String(calls[0].init.body))
      expect(params.get('line_items[0][price_data][unit_amount]')).toBe('12500')
    }
  })

  it('verify by session reports paid sessions and pending open sessions', async () => {
    const paid = createStripeProvider({
      ...config,
      transport: captureTransport([
        jsonResponse({
          id: 'cs_test_123',
          payment_status: 'paid',
          status: 'complete',
          payment_intent: 'pi_test_1',
          amount_total: 12_500,
          currency: 'usd',
          // Deliberately far in the past: the session OBJECT creation
          // time must never be presented as a payment time.
          created: Math.floor(nowMs / 1000) - 30 * 24 * 3600,
        }),
      ]).transport,
    })
    const verified = await paid.verifyPayment({
      ...usdAttempt,
      providerCheckoutId: 'cs_test_123',
    })
    expect(verified.outcome).toBe('SUCCEEDED')
    // Direct API verification carries no payment-completion timestamp —
    // paidAtSql is null and settlement stamps its own fresh clock.
    expect(verified.paidAtSql).toBeNull()

    const open = createStripeProvider({
      ...config,
      transport: captureTransport([
        jsonResponse({
          id: 'cs_test_123',
          payment_status: 'unpaid',
          status: 'open',
        }),
      ]).transport,
    })
    const pending = await open.verifyPayment({
      ...usdAttempt,
      providerCheckoutId: 'cs_test_123',
    })
    expect(pending.outcome).toBe('PENDING')
  })
})

// --- PayPal (§69) -----------------------------------------------------------

describe('PayPal adapter', () => {
  const config = {
    enabled: true,
    envName: 'sandbox' as const,
    clientId: 'paypal_client_id',
    clientSecret: 'paypal_client_secret',
    webhookId: 'WH-TEST-1',
    currencies: ['USD', 'GBP', 'EUR'],
  }
  const usdAttempt: AttemptIdentity = {
    ...attempt,
    currency: 'USD',
    amountMinor: 500_000,
    providerCheckoutId: 'ORDER-1',
  }
  const oauthResponse = () =>
    jsonResponse({ access_token: 'A21.token', expires_in: 3600 })

  it('creates an order via mocked OAuth with decimal amount and idempotent request id', async () => {
    const { transport, calls } = captureTransport([
      oauthResponse(),
      jsonResponse({
        id: 'ORDER-1',
        status: 'PAYER_ACTION_REQUIRED',
        links: [
          { rel: 'self', href: 'https://api.sandbox/self' },
          {
            rel: 'payer-action',
            href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1',
          },
        ],
      }),
    ])
    const provider = createPaypalProvider({ ...config, transport })
    const result = await provider.initializePayment({
      ...initInput,
      attempt: { ...usdAttempt, providerCheckoutId: null },
    })
    expect(result.providerCheckoutId).toBe('ORDER-1')
    expect(result.checkoutUrl).toContain('checkoutnow')

    // First call OAuth (secret only in server-side basic auth), second
    // the order create.
    expect(calls[0].url).toContain('/v1/oauth2/token')
    const orderCall = calls[1]
    const headers = orderCall.init.headers as Record<string, string>
    expect(headers['PayPal-Request-Id']).toBe(usdAttempt.idempotencyKey)
    const body = JSON.parse(String(orderCall.init.body)) as {
      intent: string
      purchase_units: Array<{
        custom_id: string
        invoice_id: string
        amount: { currency_code: string; value: string }
      }>
    }
    expect(body.intent).toBe('CAPTURE')
    expect(body.purchase_units[0].amount.value).toBe('5000.00')
    expect(body.purchase_units[0].amount.currency_code).toBe('USD')
    expect(body.purchase_units[0].custom_id).toBe(usdAttempt.publicId)
  })

  it('caches the OAuth token across calls', async () => {
    const { transport, calls } = captureTransport([
      oauthResponse(),
      jsonResponse({ id: 'ORDER-1', status: 'CREATED', purchase_units: [] }),
      jsonResponse({ id: 'ORDER-1', status: 'CREATED', purchase_units: [] }),
    ])
    const provider = createPaypalProvider({ ...config, transport })
    await provider.verifyPayment(usdAttempt)
    await provider.verifyPayment(usdAttempt)
    const tokenCalls = calls.filter((c) => c.url.includes('/v1/oauth2/token'))
    expect(tokenCalls.length).toBe(1)
  })

  it('maps COMPLETED captures to success with parsed minor amount', async () => {
    const { transport } = captureTransport([
      oauthResponse(),
      jsonResponse({
        id: 'ORDER-1',
        status: 'COMPLETED',
        purchase_units: [
          {
            custom_id: usdAttempt.publicId,
            payments: {
              captures: [
                {
                  id: 'CAP-1',
                  status: 'COMPLETED',
                  amount: { currency_code: 'USD', value: '5000.00' },
                  create_time: '2026-08-08T10:15:30Z',
                  custom_id: usdAttempt.publicId,
                },
              ],
            },
          },
        ],
      }),
    ])
    const provider = createPaypalProvider({ ...config, transport })
    const verified = await provider.capturePayment!(usdAttempt)
    expect(verified.outcome).toBe('SUCCEEDED')
    expect(verified.amountMinor).toBe(500_000)
    expect(verified.currency).toBe('USD')
    expect(verified.providerPaymentId).toBe('CAP-1')
    expect(verified.attemptPublicId).toBe(usdAttempt.publicId)
  })

  it('maps declined captures to failure and mismatched amounts truthfully', async () => {
    const { transport } = captureTransport([
      oauthResponse(),
      jsonResponse({
        id: 'ORDER-1',
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              captures: [
                {
                  id: 'CAP-2',
                  status: 'DECLINED',
                  amount: { currency_code: 'USD', value: '5000.00' },
                },
              ],
            },
          },
        ],
      }),
    ])
    const provider = createPaypalProvider({ ...config, transport })
    const declined = await provider.capturePayment!(usdAttempt)
    expect(declined.outcome).toBe('FAILED')

    // A different captured amount is reported exactly as the provider
    // said — the DOMAIN decides it cannot confirm (AMOUNT_MISMATCH).
    const { transport: t2 } = captureTransport([
      oauthResponse(),
      jsonResponse({
        id: 'ORDER-1',
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              captures: [
                {
                  id: 'CAP-3',
                  status: 'COMPLETED',
                  amount: { currency_code: 'USD', value: '4999.00' },
                },
              ],
            },
          },
        ],
      }),
    ])
    const provider2 = createPaypalProvider({ ...config, transport: t2 })
    const mismatched = await provider2.capturePayment!(usdAttempt)
    expect(mismatched.outcome).toBe('SUCCEEDED')
    expect(mismatched.amountMinor).toBe(499_900)
  })

  it('never fabricates a terminal failure from non-terminal capture rejections', async () => {
    // ORDER_NOT_APPROVED: the buyer simply has not approved yet — the
    // attempt must stay live (PENDING), never FAILED.
    const notApproved = createPaypalProvider({
      ...config,
      transport: captureTransport([
        oauthResponse(),
        jsonResponse(
          {
            name: 'UNPROCESSABLE_ENTITY',
            details: [{ issue: 'ORDER_NOT_APPROVED' }],
          },
          422,
        ),
      ]).transport,
    })
    const pending = await notApproved.capturePayment!(usdAttempt)
    expect(pending.outcome).toBe('PENDING')
    expect(pending.failureCode).toBeNull()

    // 401 auth expiry: retryable error + token cache dropped so the
    // retry re-authenticates — never a payment verdict.
    const { transport, calls } = captureTransport([
      oauthResponse(),
      jsonResponse({ name: 'UNAUTHORIZED' }, 401),
      oauthResponse(),
      jsonResponse({ id: 'ORDER-1', status: 'CREATED', purchase_units: [] }),
    ])
    const authExpiring = createPaypalProvider({ ...config, transport })
    let thrown: unknown = null
    try {
      await authExpiring.capturePayment!(usdAttempt)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PaymentProviderError)
    expect((thrown as PaymentProviderError).retryable).toBe(true)
    await authExpiring.verifyPayment(usdAttempt)
    const tokenCalls = calls.filter((c) => c.url.includes('/v1/oauth2/token'))
    expect(tokenCalls.length).toBe(2)

    // 429 rate limit: retryable, ledger untouched.
    const throttled = createPaypalProvider({
      ...config,
      transport: captureTransport([
        oauthResponse(),
        jsonResponse({ name: 'RATE_LIMIT_REACHED' }, 429),
      ]).transport,
    })
    let thrown429: unknown = null
    try {
      await throttled.capturePayment!(usdAttempt)
    } catch (error) {
      thrown429 = error
    }
    expect(thrown429).toBeInstanceOf(PaymentProviderError)
    expect((thrown429 as PaymentProviderError).retryable).toBe(true)
  })

  const captureCompletedEvent = {
    id: 'WH-EVT-1',
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: {
      id: 'CAP-1',
      status: 'COMPLETED',
      amount: { currency_code: 'USD', value: '5000.00' },
      create_time: '2026-08-08T10:15:30Z',
      custom_id: usdAttempt.publicId,
      supplementary_data: { related_ids: { order_id: 'ORDER-1' } },
    },
  }
  const transmissionHeaders = {
    'paypal-transmission-id': 'tid-1',
    'paypal-transmission-time': '2026-08-08T10:15:31Z',
    'paypal-transmission-sig': 'sig',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
    'paypal-auth-algo': 'SHA256withRSA',
  }

  it('accepts webhooks only when the official verification API says SUCCESS', async () => {
    const rawBody = new TextEncoder().encode(
      JSON.stringify(captureCompletedEvent),
    )
    const verifying = createPaypalProvider({
      ...config,
      transport: captureTransport([
        oauthResponse(),
        jsonResponse({ verification_status: 'SUCCESS' }),
      ]).transport,
    })
    const ok = await verifying.parseAndVerifyWebhook(
      rawBody,
      transmissionHeaders,
    )
    expect(ok.ok).toBe(true)
    expect(ok.relevant).toBe(true)
    expect(ok.verified?.outcome).toBe('SUCCEEDED')
    expect(ok.verified?.providerCheckoutId).toBe('ORDER-1')

    const failing = createPaypalProvider({
      ...config,
      transport: captureTransport([
        oauthResponse(),
        jsonResponse({ verification_status: 'FAILURE' }),
      ]).transport,
    })
    const bad = await failing.parseAndVerifyWebhook(
      rawBody,
      transmissionHeaders,
    )
    expect(bad.ok).toBe(false)
  })

  it('posts back the EXACT raw webhook event — never a re-serialized reconstruction', async () => {
    // Deliberately NON-CANONICAL but valid JSON: unusual whitespace,
    // unusual key ordering (event_type before id), escaped Unicode and
    // nested formatting. PayPal's postback verification requires the
    // original representation.
    const rawEventText =
      '{\n' +
      '  "event_type" :\t"PAYMENT.CAPTURE.COMPLETED" ,\n' +
      '  "id"  : "WH-EVT-RAW-1",\n' +
      '  "resource" : {\n' +
      '      "status" : "COMPLETED",\n' +
      '      "id" : "CAP-9",\n' +
      '      "amount" : { "currency_code" : "USD" ,  "value" : "5000.00" },\n' +
      '      "custom_id" : "\\u0041d\\u00e9w\\u00e1l\\u00e9-attempt"\n' +
      '  }\n' +
      '}'
    const rawBody = new TextEncoder().encode(rawEventText)
    const { transport, calls } = captureTransport([
      oauthResponse(),
      jsonResponse({ verification_status: 'SUCCESS' }),
    ])
    const provider = createPaypalProvider({ ...config, transport })
    const result = await provider.parseAndVerifyWebhook(
      rawBody,
      transmissionHeaders,
    )
    expect(result.ok).toBe(true)
    expect(result.verified?.outcome).toBe('SUCCEEDED')
    expect(result.verified?.amountMinor).toBe(500_000)

    const verifyCall = calls.find((c) =>
      c.url.includes('/v1/notifications/verify-webhook-signature'),
    )
    expect(verifyCall).toBeDefined()
    const body = String(verifyCall!.init.body)
    // The original bytes appear VERBATIM as the webhook_event value…
    expect(body).toContain(`"webhook_event":${rawEventText}`)
    // …inside a well-formed JSON document whose surrounding fields are
    // safely encoded.
    const parsedBody = JSON.parse(body) as Record<string, unknown>
    expect(parsedBody.webhook_id).toBe(config.webhookId)
    expect(parsedBody.auth_algo).toBe('SHA256withRSA')
    expect(parsedBody.transmission_id).toBe('tid-1')
    expect(parsedBody.webhook_event).toEqual(JSON.parse(rawEventText))

    // Regression: the OLD parse→JSON.stringify approach produces a
    // DIFFERENT representation (whitespace collapsed, key order
    // normalized, \uXXXX escapes decoded) — proving it would not have
    // posted back the original event.
    const reserialized = JSON.stringify(JSON.parse(rawEventText))
    expect(reserialized).not.toBe(rawEventText)
    expect(body).not.toContain(`"webhook_event":${reserialized}`)
  })

  it('rejects malformed or non-object webhook JSON before contacting PayPal', async () => {
    const provider = createPaypalProvider({
      ...config,
      transport: captureTransport([oauthResponse()]).transport,
    })
    for (const bad of ['not json {{{', '[1,2,3]', '"just a string"', 'null']) {
      const result = await provider.parseAndVerifyWebhook(
        new TextEncoder().encode(bad),
        transmissionHeaders,
      )
      expect(result.ok).toBe(false)
      expect(result.reason).toBe('unparseable_payload')
    }
  })

  it('rejects webhooks missing transmission headers without calling PayPal', async () => {
    const { transport, calls } = captureTransport([oauthResponse()])
    const provider = createPaypalProvider({ ...config, transport })
    const rawBody = new TextEncoder().encode(
      JSON.stringify(captureCompletedEvent),
    )
    const result = await provider.parseAndVerifyWebhook(rawBody, {})
    expect(result.ok).toBe(false)
    expect(calls.length).toBe(0)
  })
})

// --- Crypto contract + mock (§70) -------------------------------------------

describe('Crypto provider (mock only)', () => {
  const config = {
    nodeEnv: 'test',
    enabled: true,
    providerName: 'mock',
    webhookSecret: '',
    fiatCurrencies: ['USD'],
    now: () => Date.UTC(2026, 7, 8, 12, 0, 0),
  }

  it('issues stablecoin quotes with decimal-string amounts (never floats)', async () => {
    const provider = createCryptoProvider(config)
    const result = await provider.initializePayment({
      ...initInput,
      attempt: { ...attempt, currency: 'USD', amountMinor: 12_550 },
    })
    expect(result.cryptoQuote).not.toBeNull()
    expect(result.cryptoQuote!.quotedAsset).toBe('USDC')
    expect(typeof result.cryptoQuote!.quotedAmount).toBe('string')
    expect(result.cryptoQuote!.quotedAmount).toBe('125.500000')
    expect(result.cryptoQuote!.quotedNetwork).toBe('MOCK-TESTNET')
    expect(result.cryptoQuote!.quoteExpiresAt).toBe('2026-08-08 12:15:00')
  })

  it('verifies signed invoice events and rejects invalid signatures', async () => {
    const provider = createCryptoProvider(config)
    const fixture = {
      id: 'crypto-evt-1',
      type: 'invoice.paid' as const,
      reference: attempt.idempotencyKey,
      fiatAmountMinor: 12_550,
      fiatCurrency: 'USD',
      paidAtMs: Date.UTC(2026, 7, 8, 12, 5, 0),
    }
    const { rawBody, headers } = buildMockCryptoWebhook(fixture)
    const ok = await provider.parseAndVerifyWebhook(rawBody, headers)
    expect(ok.ok).toBe(true)
    expect(ok.verified?.outcome).toBe('SUCCEEDED')
    expect(ok.verified?.amountMinor).toBe(12_550)

    const mutated = new Uint8Array(rawBody)
    mutated[mutated.length - 2] = 32
    const bad = await provider.parseAndVerifyWebhook(mutated, headers)
    expect(bad.ok).toBe(false)
  })

  it('fails safe: no invented vendor, and mock can never run in production', () => {
    // A non-mock processor name is NOT available — no vendor is invented.
    const invented = createCryptoProvider({
      ...config,
      providerName: 'some-vendor',
    })
    expect(invented.isEnabled()).toBe(false)
    expect(invented.canVerifyWebhooks()).toBe(false)

    const production = createCryptoProvider({
      ...config,
      nodeEnv: 'production',
    })
    expect(production.isEnabled()).toBe(false)
    expect(production.canVerifyWebhooks()).toBe(false)
  })

  it('text/screenshot-style payloads cannot become payment truth', async () => {
    const provider = createCryptoProvider(config)
    // Unsigned "proof" is rejected before any parsing decisions.
    const claim = new TextEncoder().encode(
      JSON.stringify({ message: 'I sent it, here is the tx hash: 0xabc' }),
    )
    const result = await provider.parseAndVerifyWebhook(claim, {})
    expect(result.ok).toBe(false)
  })
})

// --- Mock provider safety (§52) ---------------------------------------------

describe('Mock payment provider', () => {
  it('is available outside production and never inside it', () => {
    const dev = createMockProvider({ nodeEnv: 'development', enabled: true })
    expect(dev.isEnabled()).toBe(true)
    const prod = createMockProvider({ nodeEnv: 'production', enabled: true })
    expect(prod.isEnabled()).toBe(false)
    expect(prod.canVerifyWebhooks()).toBe(false)
  })

  it('verifies signed fixtures and rejects tampered ones', async () => {
    const provider = createMockProvider({ nodeEnv: 'test', enabled: true })
    const { rawBody, headers } = buildMockWebhook({
      id: 'mock-evt-1',
      type: 'payment.succeeded',
      reference: attempt.idempotencyKey,
      amountMinor: 500_000,
      currency: 'NGN',
      paidAtMs: Date.UTC(2026, 7, 8, 12, 0, 0),
    })
    const ok = await provider.parseAndVerifyWebhook(rawBody, headers)
    expect(ok.ok).toBe(true)
    expect(ok.verified?.outcome).toBe('SUCCEEDED')

    const mutated = new Uint8Array(rawBody)
    mutated[2] = 32
    const bad = await provider.parseAndVerifyWebhook(mutated, headers)
    expect(bad.ok).toBe(false)
  })
})

// --- Environment enablement validation (§57/§58) ----------------------------

describe('payment environment validation', () => {
  // A COMPLETE production baseline. Step 20 made production require
  // more than payments alone — real object storage, a real renderer,
  // and a non-mock setting for the two unapproved adapters — so this
  // fixture now supplies them. Every case below still varies only the
  // payment settings, which is what it is testing.
  const base = {
    NODE_ENV: 'production',
    DATABASE_PASSWORD: 'x',
    APP_BASE_URL: 'https://example.org',
    TRUST_PROXY: 'false',
    OBJECT_STORAGE_DRIVER: 'S3',
    OBJECT_STORAGE_ENDPOINT: 'https://s3.example',
    OBJECT_STORAGE_REGION: 'eu-west-1',
    OBJECT_STORAGE_BUCKET: 'bucket-placeholder',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'key-id-placeholder',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secret-placeholder',
    RENDER_DRIVER: 'REMOTION',
    VISUAL_GENERATION_DRIVER: 'DISABLED',
    TTS_DRIVER: 'DISABLED',
    NOTIFICATION_EMAIL_DRIVER: 'DISABLED',
  }

  it('defaults everything payment to disabled', () => {
    const env = envSchema.parse({})
    expect(env.PAYMENTS_ENABLED).toBe(false)
    expect(env.PAYSTACK_ENABLED).toBe(false)
    expect(env.PAYPAL_ENABLED).toBe(false)
    expect(env.STRIPE_ENABLED).toBe(false)
    expect(env.CRYPTO_ENABLED).toBe(false)
  })

  it('refuses providers enabled without their credentials', () => {
    expect(
      envSchema.safeParse({ ...base, PAYSTACK_ENABLED: 'true' }).success,
    ).toBe(false)
    expect(
      envSchema.safeParse({ ...base, STRIPE_ENABLED: 'true' }).success,
    ).toBe(false)
    expect(
      envSchema.safeParse({ ...base, PAYPAL_ENABLED: 'true' }).success,
    ).toBe(false)
    expect(
      envSchema.safeParse({
        ...base,
        PAYSTACK_ENABLED: 'true',
        PAYSTACK_SECRET_KEY: 'sk_test_x',
      }).success,
    ).toBe(true)
  })

  it('refuses crypto misconfiguration: mock in production, unknown vendors anywhere', () => {
    expect(
      envSchema.safeParse({ ...base, CRYPTO_ENABLED: 'true' }).success,
    ).toBe(false)
    expect(
      envSchema.safeParse({
        ...base,
        CRYPTO_ENABLED: 'true',
        CRYPTO_PROVIDER: 'coinbase',
      }).success,
    ).toBe(false)
    expect(
      envSchema.safeParse({
        NODE_ENV: 'development',
        CRYPTO_ENABLED: 'true',
        CRYPTO_PROVIDER: 'mock',
      }).success,
    ).toBe(true)
  })

  it('requires HTTPS APP_BASE_URL for production payments and parses currency lists', () => {
    expect(
      envSchema.safeParse({
        ...base,
        APP_BASE_URL: 'http://plain.example.org',
        PAYMENTS_ENABLED: 'true',
      }).success,
    ).toBe(false)
    const env = envSchema.parse({
      PAYSTACK_CURRENCIES: 'ngn, usd,,bad1',
    })
    expect(env.PAYSTACK_CURRENCIES).toEqual(['NGN', 'USD'])
  })
})
