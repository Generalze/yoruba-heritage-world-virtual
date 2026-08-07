import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Resolves a URL pathname to an absolute file path strictly contained
 * within rootDir, or undefined if the request must not be served.
 *
 * Containment is established with path.relative() against the resolved
 * root — never a string-prefix comparison — so a request can never
 * escape the root via `..` segments, percent-encoded traversal,
 * absolute paths, or sibling directories whose names merely start with
 * the root's name (e.g. `dist/client-secrets` next to `dist/client`).
 *
 * Purely computational: performs no filesystem access, so callers must
 * still verify the returned path points at a real file.
 */
export function resolveContainedPath(
  rootDir: string,
  requestPath: string,
): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return undefined
  }
  if (decoded.includes('\0')) return undefined

  const root = resolve(rootDir)
  // Strip leading slashes so URL-absolute pathnames resolve relative to
  // the root instead of the filesystem root (or a Windows drive root).
  const candidate = resolve(root, decoded.replace(/^[/\\]+/, ''))

  const rel = relative(root, candidate)
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return undefined
  }
  return candidate
}
