/**
 * Container runtime smoke check (Phase One, Step 20 hardening).
 *
 *   bun run scripts/runtime-smoke.ts
 *
 * Proves, AS THE UNPRIVILEGED CONTAINER USER, that this image can
 * actually do the work it was built for — before a paid appointment
 * discovers it cannot:
 *
 *   - the shared media path is writable (approved and intermediate
 *     media live there, and both processes mount the same volume);
 *   - ffprobe is present and executable (the renderer measures real
 *     media with it and refuses to plan a timeline without it);
 *   - the headless browser is present and executable (baked into the
 *     image, so the first render is not a download).
 *
 * IT DOWNLOADS NOTHING AND RENDERS NOTHING. No network, no provider,
 * no media: it resolves executables and writes one small file. That is
 * deliberate — a smoke check that needs the internet cannot run in the
 * place it is most needed.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { env } from '@/lib/env'
import { checkRenderRuntimeDependencies } from '@/providers/render/media-probe'

const failures: Array<string> = []

async function checkMediaPathWritable(): Promise<void> {
  const root =
    process.env.MEDIA_STORAGE_DIR ?? join(process.cwd(), 'var', 'media')
  const probeDir = join(root, '.smoke')
  try {
    await mkdir(probeDir, { recursive: true })
    const probeFile = join(probeDir, 'write-probe')
    await writeFile(probeFile, 'ok')
    await rm(probeDir, { recursive: true, force: true })
    console.log('[smoke] media path writable: ok')
  } catch {
    // The PATH is named here because this runs inside the container for
    // an operator, not over HTTP for a stranger.
    failures.push(`media path is not writable: ${root}`)
  }
}

async function checkRenderTooling(): Promise<void> {
  const runtime = await checkRenderRuntimeDependencies()
  if (runtime.ok) {
    console.log('[smoke] render tooling: ok (ffprobe, browser)')
    return
  }
  for (const capability of runtime.missing) {
    failures.push(`render tooling missing: ${capability}`)
  }
}

console.log(`[smoke] user: uid=${process.getuid?.() ?? 'n/a'}`)
console.log(`[smoke] render driver: ${env.RENDER_DRIVER}`)
await checkMediaPathWritable()
await checkRenderTooling()

if (failures.length > 0) {
  for (const failure of failures) console.error(`[smoke] FAIL ${failure}`)
  process.exit(1)
}
console.log('[smoke] all checks passed')
