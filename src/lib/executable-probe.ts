import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

/**
 * "Is this binary here, and can I run it?" — and nothing else.
 *
 * DELIBERATELY FREE OF EVERY APPLICATION IMPORT, especially the
 * validated environment singleton. The container smoke check needs to
 * answer exactly this question about a freshly built image, at a moment
 * when no payment, storage or database credentials have been wired up
 * yet — and importing `@/lib/env` would make it refuse to run for
 * reasons that have nothing to do with whether ffprobe exists.
 *
 * It resolves paths and asks the filesystem. It spawns nothing, reads
 * no media and makes no network call.
 */

export async function isExecutableFile(path: string): Promise<boolean> {
  if (path.trim() === '') return false
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolves a bare command name against PATH, the way a shell would.
 * An absolute or relative path is checked directly. */
export async function isResolvableExecutable(command: string): Promise<boolean> {
  if (command.trim() === '') return false
  if (command.includes('/') || command.includes('\\')) {
    return isExecutableFile(command)
  }
  const pathValue = process.env.PATH ?? ''
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
      : ['']
  for (const dir of pathValue.split(delimiter)) {
    if (dir.trim() === '') continue
    for (const extension of extensions) {
      if (await isExecutableFile(join(dir, `${command}${extension}`))) {
        return true
      }
    }
  }
  return false
}

/**
 * The ONE definition of "can this machine perform a real render".
 *
 * Takes the two paths explicitly so the same logic serves three callers
 * that must never disagree — HTTP readiness, the worker's startup gate
 * and the offline container smoke check — without any of them
 * duplicating filesystem logic or reaching for configuration the others
 * do not have.
 */
export interface RenderRuntimeReadiness {
  ok: boolean
  /** Bounded capability names — NEVER a filesystem path. A readiness
   * response is public, and a log is read by people who should not have
   * to redact it. */
  missing: ReadonlyArray<string>
}

export async function checkRenderRuntimePaths(input: {
  ffprobePath: string
  browserPath: string
}): Promise<RenderRuntimeReadiness> {
  const missing: Array<string> = []
  if (!(await isResolvableExecutable(input.ffprobePath))) missing.push('ffprobe')
  // An unset browser path means Remotion would provision one itself — a
  // download at the moment of somebody's paid render. Production bakes
  // it into the image and names it, so "unset" is reported missing
  // rather than quietly accepted.
  if (!(await isExecutableFile(input.browserPath.trim()))) {
    missing.push('render_browser')
  }
  return { ok: missing.length === 0, missing }
}
