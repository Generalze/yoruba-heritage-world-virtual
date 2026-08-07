/// <reference types="bun" />
/**
 * Production server entry (Bun) — see the TanStack Start hosting guide.
 *
 * Serves the static client build from dist/client and forwards every
 * other request (SSR pages, /api/* server routes) to the built Start
 * fetch handler. Run `bun run build` first, then `bun run start`.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'

import { resolveContainedPath } from './src/lib/static-files'

// @ts-expect-error — compiled server bundle exists only after `bun run build`
import serverEntryModule from './dist/server/server.js'

const serverEntry = serverEntryModule as {
  fetch: (request: Request) => Promise<Response>
}

const clientDir = join(import.meta.dir, 'dist', 'client')
const port = Number(process.env.APP_PORT ?? process.env.PORT ?? 3000)

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
    const url = new URL(request.url)
    const staticPath = findStaticFile(url.pathname)

    if (staticPath) {
      return new Response(Bun.file(staticPath), {
        headers: url.pathname.startsWith('/assets/')
          ? { 'Cache-Control': 'public, max-age=31536000, immutable' }
          : { 'Cache-Control': 'public, max-age=3600' },
      })
    }

    return serverEntry.fetch(request)
  },
})

console.log(
  `Yorùbá Heritage World Virtual running at http://localhost:${server.port}`,
)
