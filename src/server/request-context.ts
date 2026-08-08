import { getRequestHeader, getRequestIP } from '@tanstack/react-start/server'

import { env } from '@/lib/env'
import type { RequestContext } from '@/auth/service'

/**
 * Request context for auditing. X-Forwarded-For is honored only behind
 * an explicitly trusted proxy (TRUST_PROXY=true); otherwise the socket
 * address is authoritative so clients cannot spoof their IP.
 */
export function requestContext(): RequestContext {
  return {
    ipAddress: getRequestIP({ xForwardedFor: env.TRUST_PROXY }) ?? null,
    userAgent: getRequestHeader('user-agent') ?? null,
  }
}
