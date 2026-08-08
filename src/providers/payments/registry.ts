import { env } from '@/lib/env'
import { createCryptoProvider } from './crypto'
import { createMockProvider } from './mock'
import { createPaypalProvider } from './paypal'
import { createPaystackProvider } from './paystack'
import { createStripeProvider } from './stripe'
import type { PaymentProvider } from './types'
import type { PaymentProviderCode } from '@/db/schema'

/**
 * Payment provider registry (spec §7/§8). The ONLY way application
 * services obtain a provider — no `if provider === …` blocks anywhere
 * else in the codebase.
 *
 * Availability for checkout requires ALL of: global PAYMENTS_ENABLED,
 * the provider's own switch, complete credentials, and the appointment
 * currency on the operator's allowlist. Webhook verification is gated
 * separately (credentials only) so late money is still verified and
 * recorded after an operator disables a provider.
 */

let registry: Map<PaymentProviderCode, PaymentProvider> | null = null
/** Test-only overrides (bun test cannot re-parse module-level env). */
let testRegistry: Map<PaymentProviderCode, PaymentProvider> | null = null
let testPaymentsEnabled: boolean | null = null

function buildRegistry(): Map<PaymentProviderCode, PaymentProvider> {
  const providers: Array<PaymentProvider> = [
    createPaystackProvider({
      enabled: env.PAYSTACK_ENABLED,
      secretKey: env.PAYSTACK_SECRET_KEY,
      currencies: env.PAYSTACK_CURRENCIES,
    }),
    createPaypalProvider({
      enabled: env.PAYPAL_ENABLED,
      envName: env.PAYPAL_ENV,
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      webhookId: env.PAYPAL_WEBHOOK_ID,
      currencies: env.PAYPAL_CURRENCIES,
    }),
    createStripeProvider({
      enabled: env.STRIPE_ENABLED,
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      currencies: env.STRIPE_CURRENCIES,
    }),
    createCryptoProvider({
      nodeEnv: env.NODE_ENV,
      enabled: env.CRYPTO_ENABLED,
      providerName: env.CRYPTO_PROVIDER,
      webhookSecret: env.CRYPTO_WEBHOOK_SECRET,
      fiatCurrencies: env.CRYPTO_FIAT_CURRENCIES,
    }),
    createMockProvider({
      nodeEnv: env.NODE_ENV,
      // The mock rides the global switch only — it exists precisely for
      // credential-less development and never runs in production.
      enabled: env.PAYMENTS_ENABLED,
    }),
  ]
  return new Map(providers.map((provider) => [provider.code, provider]))
}

export function getPaymentRegistry(): Map<
  PaymentProviderCode,
  PaymentProvider
> {
  if (testRegistry) return testRegistry
  registry ??= buildRegistry()
  return registry
}

/**
 * Test hooks ONLY (never referenced by runtime code): the environment
 * is parsed once at module load, so integration tests inject their own
 * provider set (mock transports — no live provider is ever reachable
 * from automated tests) and a payments-enabled flag.
 */
export function setPaymentRegistryForTests(
  providers: Array<PaymentProvider>,
  paymentsEnabled: boolean,
): void {
  testRegistry = new Map(providers.map((provider) => [provider.code, provider]))
  testPaymentsEnabled = paymentsEnabled
}

export function resetPaymentRegistryForTests(): void {
  registry = null
  testRegistry = null
  testPaymentsEnabled = null
}

function isPaymentsGloballyEnabled(): boolean {
  return testPaymentsEnabled ?? env.PAYMENTS_ENABLED
}

export function getPaymentProvider(
  code: PaymentProviderCode,
): PaymentProvider | null {
  return getPaymentRegistry().get(code) ?? null
}

/** Providers a user may currently check out with for this currency. */
export function listAvailableProviders(
  currency: string,
): Array<{ code: PaymentProviderCode; displayName: string }> {
  if (!isPaymentsGloballyEnabled()) return []
  const available: Array<{ code: PaymentProviderCode; displayName: string }> =
    []
  for (const provider of getPaymentRegistry().values()) {
    if (provider.isEnabled() && provider.supportsCurrency(currency)) {
      available.push({ code: provider.code, displayName: provider.displayName })
    }
  }
  return available
}

/** Provider able to authenticate incoming webhooks (credentials
 * present), independent of checkout enablement. */
export function getWebhookProvider(
  code: PaymentProviderCode,
): PaymentProvider | null {
  const provider = getPaymentRegistry().get(code)
  return provider && provider.canVerifyWebhooks() ? provider : null
}
