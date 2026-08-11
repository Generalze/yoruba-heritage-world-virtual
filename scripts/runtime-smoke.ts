/**
 * Container runtime smoke check (Phase One, Step 20 hardening).
 *
 *   bun run smoke:runtime
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
 * IT NEEDS NO APPLICATION CREDENTIALS. This deliberately does NOT
 * import the validated environment singleton: doing so would make a
 * check about ffmpeg and a directory refuse to run because a payment
 * key or a database password had not been wired up yet — which is
 * exactly the moment you most want to verify a freshly built image. It
 * reads the three raw variables it needs and nothing else.
 *
 * IT DOWNLOADS NOTHING AND RENDERS NOTHING. No network, no provider, no
 * media: it resolves two executables and writes one small file. A smoke
 * check that needs the internet cannot run in the place it is most
 * needed.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { checkRenderRuntimePaths } from '@/lib/executable-probe'

const failures: Array<string> = []

/** The same defaults the image bakes in, read RAW so this file has no
 * application dependencies at all. */
const mediaRoot =
  process.env.MEDIA_STORAGE_DIR?.trim() ?? join(process.cwd(), 'var', 'media')
const ffprobePath =
  process.env.FFPROBE_PATH?.trim() === '' || process.env.FFPROBE_PATH == null
    ? 'ffprobe'
    : process.env.FFPROBE_PATH
const browserPath = process.env.REMOTION_BROWSER_EXECUTABLE?.trim() ?? ''

async function checkMediaPathWritable(): Promise<void> {
  const probeDir = join(mediaRoot, '.smoke')
  try {
    await mkdir(probeDir, { recursive: true })
    await writeFile(join(probeDir, 'write-probe'), 'ok')
    await rm(probeDir, { recursive: true, force: true })
    console.log('[smoke] media path writable: ok')
  } catch {
    // A CAPABILITY, not a path. This output is read in CI logs and
    // pasted into support threads; a deployment's directory layout is
    // not something to scatter through either.
    failures.push('media_path_not_writable')
  }
}

async function checkRenderTooling(): Promise<void> {
  const runtime = await checkRenderRuntimePaths({ ffprobePath, browserPath })
  if (runtime.ok) {
    console.log('[smoke] render tooling: ok (ffprobe, browser)')
    return
  }
  for (const capability of runtime.missing) {
    failures.push(`render_tooling_missing_${capability}`)
  }
}

console.log(`[smoke] user: uid=${process.getuid?.() ?? 'n/a'}`)
await checkMediaPathWritable()
await checkRenderTooling()

if (failures.length > 0) {
  for (const failure of failures) console.error(`[smoke] FAIL ${failure}`)
  process.exit(1)
}
console.log('[smoke] all checks passed')
