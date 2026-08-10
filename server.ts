/// <reference types="bun" />
/**
 * Production server entry (Bun) — see the TanStack Start hosting guide.
 *
 * Serves the static client build from dist/client and forwards every
 * other request (SSR pages, /api/* server routes) to the built Start
 * fetch handler. Run `bun run build` first, then `bun run start`.
 *
 * Step 20 added three things around that, in this order:
 *   1. the production preflight, which refuses to bind a port at all
 *      when the deployment is misconfigured;
 *   2. security headers on every response, applied in one place;
 *   3. an error boundary that never shows a production client a stack
 *      trace.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'

import { resolveContainedPath } from './src/lib/static-files'
import { withSecurityHeaders } from './src/lib/security-headers'
import { assertProductionPreflight } from './src/server/production-preflight'

// @ts-expect-error — compiled server bundle exists only after `bun run build`
import serverEntryModule from './dist/server/server.js'

const serverEntry = serverEntryModule as {
  fetch: (request: Request) => Promise<Response>
}

// BEFORE THE PORT IS BOUND. A misconfigured production deployment must
// never accept a single request — not a booking, not a webhook, not a
// health check that would tell an orchestrator everything is fine.
// Throws in production; a no-op in development and test.
assertProductionPreflight('web')

const clientDir = join(import.meta.dir, 'dist', 'client')
const port = Number(process.env.APP_PORT ?? process.env.PORT ?? 3000)
const isProduction = process.env.NODE_ENV === 'production'
const isHttps = (process.env.APP_BASE_URL ?? '').startsWith('https://')
const headerOptions = { isProduction, isHttps }

function findStaticFile(pathname: string): string | undefined {
  const candidate = resolveContainedPath(clientDir, pathname)
  if (!candidate) return undefined
  try {
    if (statSync(candidate).isFile()) return candidate
  } catch {
    // not a static file — fall through to the app handler
  }
  return undefined
}

const server = Bun.serve({
  port,
  async fetch(request) {
    try {
      const url = new URL(request.url)
      const staticPath = findStaticFile(url.pathname)

      if (staticPath) {
        return withSecurityHeaders(
          new Response(Bun.file(staticPath), {
            headers: url.pathname.startsWith('/assets/')
              ? { 'Cache-Control': 'public, max-age=31536000, immutable' }
              : { 'Cache-Control': 'public, max-age=3600' },
          }),
          headerOptions,
        )
      }

      return withSecurityHeaders(await serverEntry.fetch(request), headerOptions)
    } catch (error) {
      // THE ERROR STOPS HERE. The message and stack go to the server
      // log, where an operator can read them; the client receives a
      // bare 500 with no message, no stack, no file path and no
      // framework internals. An error page that quotes an exception is
      // a reconnaissance tool.
      console.error(
        `[web] unhandled request error: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }`,
      )
      return withSecurityHeaders(
        new Response('Internal Server Error', {
          status: 500,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        }),
        headerOptions,
      )
    }
  },
})

/**
 * Graceful stop. Bun finishes in-flight requests before the process
 * exits, so a container restart or a deploy does not sever somebody
 * mid-booking or mid-payment-webhook.
 */
let stopping = false
function shutdown(signal: string): void {
  if (stopping) return
  stopping = true
  console.log(`[web] received ${signal} — draining…`)
  void server.stop(false).finally(() => {
    process.exit(0)
  })
}
process.on('SIGTERM', () => {
  shutdown('SIGTERM')
})
process.on('SIGINT', () => {
  shutdown('SIGINT')
})

console.log(
  `Yorùbá Heritage World Virtual running at http://localhost:${server.port}`,
)
