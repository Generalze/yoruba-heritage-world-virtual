import { describe, expect, it } from 'bun:test'

import { envSchema } from '@/lib/env'
import {
  contentSecurityPolicy,
  mediaOriginFromEndpoint,
  securityHeaders,
} from '@/lib/security-headers'
import { checkProductionPreflight } from '@/server/production-preflight'
import { getReadinessStatus } from '@/server/health'
import { PRAYER_ROOM_SIGNED_URL_TTL_SECONDS } from '@/services/prayer-room'
import { MAX_SIGNED_URL_TTL_SECONDS } from '@/providers/object-storage/types'

/**
 * ============================================================================
 * PHASE-ONE MEDIA DELIVERY, LOCKED — Step 20 hardening.
 *
 * The decision this suite pins: a recorded prayer is delivered by the
 * authenticated Prayer Room proof followed by a PRIVATE signed GET of
 * at most five minutes, and the browser may play it from exactly two
 * places — this origin, and the ONE configured HTTPS object-storage
 * origin.
 *
 * The failure it exists to prevent is a plausible-looking wildcard.
 * `media-src https://*.s3.amazonaws.com` reads like a policy and is the
 * absence of one: it authorises every bucket on the internet's largest
 * object store to play audio and video inside this application.
 * ============================================================================
 */

const STORAGE_ORIGIN = 'https://objects.example'
const PRODUCTION = {
  isProduction: true,
  isHttps: true,
  mediaOrigin: `${STORAGE_ORIGIN}/some/path?ignored=1`,
}

describe('media origin extraction', () => {
  it('keeps the ORIGIN and discards path, query and credentials', () => {
    expect(mediaOriginFromEndpoint(PRODUCTION.mediaOrigin)).toBe(STORAGE_ORIGIN)
    expect(mediaOriginFromEndpoint('https://objects.example:9000/bucket')).toBe(
      'https://objects.example:9000',
    )
  })

  it('refuses anything that is not HTTPS, and anything unparseable', () => {
    // A signed link delivered over plain HTTP — and the recording it
    // unlocks — is readable by anything on the path.
    expect(mediaOriginFromEndpoint('http://objects.example')).toBeNull()
    expect(mediaOriginFromEndpoint('objects.example')).toBeNull()
    expect(mediaOriginFromEndpoint('')).toBeNull()
    expect(mediaOriginFromEndpoint(null)).toBeNull()
    expect(mediaOriginFromEndpoint(undefined)).toBeNull()
  })
})

describe('content security policy for media', () => {
  it('allows self, blob and the EXACT configured origin — nothing else', () => {
    const policy = contentSecurityPolicy(PRODUCTION)
    const mediaSrc = policy
      .split('; ')
      .find((directive) => directive.startsWith('media-src '))
    expect(mediaSrc).toBe(`media-src 'self' blob: ${STORAGE_ORIGIN}`)
  })

  it('blocks an unrelated external media origin', () => {
    const policy = contentSecurityPolicy(PRODUCTION)
    // TEETH: a browser would refuse to play from any of these.
    for (const foreign of [
      'https://evil.example',
      'https://cdn.example',
      'https://another-bucket.s3.amazonaws.com',
    ]) {
      expect(policy).not.toContain(foreign)
    }
  })

  it('never emits a wildcard media source', () => {
    for (const endpoint of [
      'https://bucket.s3.amazonaws.com',
      'https://objects.example',
    ]) {
      const policy = contentSecurityPolicy({
        isProduction: true,
        isHttps: true,
        mediaOrigin: endpoint,
      })
      const mediaSrc = policy
        .split('; ')
        .find((directive) => directive.startsWith('media-src '))!
      expect(mediaSrc).not.toContain('*')
      expect(mediaSrc).not.toContain('amazonaws.com *')
    }
  })

  it('falls back to self and blob when no storage origin is configured', () => {
    // Local storage is proxied through this origin and needs no
    // external source at all.
    const policy = contentSecurityPolicy({ isProduction: false, isHttps: false })
    expect(policy).toContain("media-src 'self' blob:")
    const mediaSrc = policy
      .split('; ')
      .find((directive) => directive.startsWith('media-src '))!
    expect(mediaSrc).toBe("media-src 'self' blob:")
  })

  it('refuses to authorise an HTTP storage origin even if one is configured', () => {
    const policy = contentSecurityPolicy({
      isProduction: true,
      isHttps: true,
      mediaOrigin: 'http://objects.example',
    })
    expect(policy).not.toContain('http://objects.example')
  })

  it('is still built by the full header set', () => {
    const headers = securityHeaders(PRODUCTION)
    expect(headers['Content-Security-Policy']).toContain(STORAGE_ORIGIN)
  })
})

describe('production requires HTTPS storage delivery', () => {
  const base: Record<string, string> = {
    NODE_ENV: 'production',
    APP_BASE_URL: 'https://prayer.example',
    DATABASE_PASSWORD: 'placeholder',
    TRUST_PROXY: 'false',
    OBJECT_STORAGE_DRIVER: 'S3',
    OBJECT_STORAGE_ENDPOINT: STORAGE_ORIGIN,
    OBJECT_STORAGE_REGION: 'eu-west-1',
    OBJECT_STORAGE_BUCKET: 'private',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'key-id-placeholder',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secret-placeholder',
    RENDER_DRIVER: 'REMOTION',
    VISUAL_GENERATION_DRIVER: 'DISABLED',
    TTS_DRIVER: 'DISABLED',
  }

  it('accepts an HTTPS endpoint', () => {
    expect(() => envSchema.parse(base)).not.toThrow()
    const result = checkProductionPreflight(base, envSchema.parse(base))
    expect(result.ok).toBe(true)
  })

  it('FAILS CLOSED on a plain-HTTP storage endpoint', () => {
    const http = { ...base, OBJECT_STORAGE_ENDPOINT: 'http://objects.example' }
    // The schema refuses to build the configuration at all…
    expect(() => envSchema.parse(http)).toThrow()
    // …and the preflight names the variable, without quoting a value.
    const viaPreflight = checkProductionPreflight(http, {
      ...envSchema.parse(base),
      OBJECT_STORAGE_ENDPOINT: 'http://objects.example',
    })
    expect(viaPreflight.ok).toBe(false)
    const issue = viaPreflight.issues.find(
      (candidate) => candidate.code === 'object_storage_endpoint_not_https',
    )
    expect(issue?.envName).toBe('OBJECT_STORAGE_ENDPOINT')
  })
})

describe('the signed capability stays short and response-only', () => {
  it('is bounded to five minutes, well inside the Step 17 ceiling', () => {
    expect(PRAYER_ROOM_SIGNED_URL_TTL_SECONDS).toBe(5 * 60)
    expect(PRAYER_ROOM_SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(
      MAX_SIGNED_URL_TTL_SECONDS,
    )
  })

  it('never reaches HTML or client state', async () => {
    const page = await Bun.file('src/routes/prayer-room.$publicId.tsx').text()
    // The page knows an appointment publicId and nothing else: no
    // object key, no signed URL, no storage host, no provider.
    for (const forbidden of [
      'objectKey',
      'signedUrl',
      'createSignedReadUrl',
      'OBJECT_STORAGE',
      'X-Amz-Signature',
    ]) {
      expect(page).not.toContain(forbidden)
    }
    // Playback goes through the authenticated endpoint.
    expect(page).toContain('/api/prayer-room/')

    const service = await Bun.file('src/services/prayer-room.ts').text()
    // The signed URL lives in the redirect response and nowhere else —
    // never persisted, never logged.
    expect(service).not.toContain('console.log(signed')
    expect(service).toContain('Location: signed.url')
  })
})

describe('readiness reflects local render tooling', () => {
  it('is not_required for the mock engine', async () => {
    const readiness = await getReadinessStatus({
      renderDriver: 'MOCK',
      checkRenderRuntime: async () => ({ ok: false, missing: ['ffprobe'] }),
    })
    // The mock needs neither binary; reporting a fault here would train
    // everyone to ignore this field.
    expect(readiness.checks.renderRuntime).toBe('not_required')
    expect(readiness.issues).not.toContain('render_runtime_missing_ffprobe')
  })

  it('is NOT ready when the real engine has no tooling', async () => {
    const readiness = await getReadinessStatus({
      renderDriver: 'REMOTION',
      checkRenderRuntime: async () => ({
        ok: false,
        missing: ['ffprobe', 'render_browser'],
      }),
    })
    expect(readiness.checks.renderRuntime).toBe('unavailable')
    expect(readiness.status).toBe('not_ready')
    expect(readiness.issues).toContain('render_runtime_missing_ffprobe')
    expect(readiness.issues).toContain('render_runtime_missing_render_browser')
  })

  it('reports capability NAMES and never a filesystem path', async () => {
    const readiness = await getReadinessStatus({
      renderDriver: 'REMOTION',
      checkRenderRuntime: async () => ({ ok: false, missing: ['ffprobe'] }),
    })
    const serialized = JSON.stringify(readiness)
    for (const path of ['/usr/bin', 'C:\\', '/app/var', 'chromium']) {
      expect(serialized).not.toContain(path)
    }
  })

  it('is ok when the tooling is present', async () => {
    const readiness = await getReadinessStatus({
      renderDriver: 'REMOTION',
      checkRenderRuntime: async () => ({ ok: true, missing: [] }),
    })
    expect(readiness.checks.renderRuntime).toBe('ok')
  })
})
