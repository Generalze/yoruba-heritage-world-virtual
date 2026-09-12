import { closeDb } from '@/db'
import { pollStripeInitializedPayments } from '@/services/payments'

const result = await pollStripeInitializedPayments()
console.log(
  JSON.stringify({
    scanned: result.scanned,
    settled: result.settled,
    pending: result.pending,
    expired: result.expired,
    failed: result.failed,
    errors: result.errors,
  }),
)

await closeDb()
