import { describe, expect, it } from 'bun:test'
import { join, resolve, sep } from 'node:path'

import { resolveContainedPath } from '@/lib/static-files'

// Platform-neutral fake root; resolved the same way the helper resolves it.
const root = resolve(join('app', 'dist', 'client'))

describe('resolveContainedPath', () => {
  it('resolves normal asset paths inside the root', () => {
    expect(resolveContainedPath(root, '/assets/index-abc123.js')).toBe(
      join(root, 'assets', 'index-abc123.js'),
    )
    expect(resolveContainedPath(root, '/favicon.svg')).toBe(
      join(root, 'favicon.svg'),
    )
  })

  it('decodes percent-encoded segments before resolving', () => {
    expect(resolveContainedPath(root, '/assets/caf%C3%A9.png')).toBe(
      join(root, 'assets', 'café.png'),
    )
  })

  it('rejects the root directory itself', () => {
    expect(resolveContainedPath(root, '/')).toBeUndefined()
    expect(resolveContainedPath(root, '')).toBeUndefined()
  })

  it('rejects plain .. traversal', () => {
    expect(resolveContainedPath(root, '/../secret.txt')).toBeUndefined()
    expect(resolveContainedPath(root, '/a/../../secret.txt')).toBeUndefined()
    expect(resolveContainedPath(root, '/..')).toBeUndefined()
  })

  it('rejects percent-encoded traversal', () => {
    expect(resolveContainedPath(root, '/%2e%2e/secret.txt')).toBeUndefined()
    expect(
      resolveContainedPath(root, '/%2e%2e%2f%2e%2e%2fsecret.txt'),
    ).toBeUndefined()
    expect(resolveContainedPath(root, '/assets/%2e%2e/%2e%2e/.env')).toBe(
      undefined,
    )
  })

  it('rejects escapes into sibling directories sharing the root name as a prefix', () => {
    // The old startsWith(clientDir) check wrongly allowed dist/client-secrets.
    const escaped = resolveContainedPath(root, '/../client-secrets/creds.txt')
    expect(escaped).toBeUndefined()
  })

  it('never resolves outside the root even for absolute-looking paths', () => {
    for (const attempt of [
      '//etc/passwd',
      '/C:/Windows/win.ini',
      '/%5C%5Cserver%5Cshare',
    ]) {
      const result = resolveContainedPath(root, attempt)
      if (result !== undefined) {
        expect(result.startsWith(root + sep)).toBe(true)
      }
    }
  })

  it('rejects malformed percent-encoding and null bytes', () => {
    expect(resolveContainedPath(root, '/%zz')).toBeUndefined()
    expect(resolveContainedPath(root, '/file%00.js')).toBeUndefined()
  })

  it('still serves legitimate files whose names start with dots', () => {
    expect(resolveContainedPath(root, '/.well-known/security.txt')).toBe(
      join(root, '.well-known', 'security.txt'),
    )
    expect(resolveContainedPath(root, '/..config')).toBe(join(root, '..config'))
  })
})
