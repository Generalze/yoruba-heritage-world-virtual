/**
 * Production-safe HTTP response headers (Phase One, Step 20).
 *
 * ONE place, applied by the server entry to every response — pages,
 * server routes and static files alike. Scattering these across
 * handlers is how one route ends up without them.
 *
 * WHAT IS DELIBERATELY NOT HERE. No header attempts to compensate for
 * an authorization decision made elsewhere: the Prayer Room's private
 * media already sets its own `Cache-Control: private, no-store`, `Vary:
 * Cookie` and `nosniff` at the point where the bytes are chosen, and
 * this module never weakens them.
 */

export interface SecurityHeaderOptions {
  isProduction: boolean
  /** Whether the deployment is served over HTTPS. HSTS is meaningless
   * (and, on a plain-HTTP development box, actively harmful — browsers
   * remember it) unless it is. */
  isHttps: boolean
  /**
   * The ONE external origin a recorded prayer may be fetched from: the
   * configured private object-storage endpoint, scheme and host only.
   *
   * Optional, and absent by default — a deployment serving media from
   * local storage proxies it through this origin and needs nothing
   * else. When present it is an EXACT origin. There is deliberately no
   * wildcard: `https://*.s3.amazonaws.com` would authorise every bucket
   * on the internet's largest object store to play audio and video
   * inside this application, which is not a policy, it is the absence
   * of one.
   */
  mediaOrigin?: string | null
}

/**
 * Extracts the exact origin from a configured storage endpoint.
 *
 * Returns null for anything that is not a well-formed HTTPS URL —
 * including plain HTTP, which must never appear in a browser-delivery
 * policy. Path, query and credentials are discarded: a CSP source is an
 * origin, and carrying anything more would leak configuration into
 * every response header.
 */
export function mediaOriginFromEndpoint(
  endpoint: string | null | undefined,
): string | null {
  if (endpoint == null || endpoint.trim() === '') return null
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  return parsed.origin
}

/**
 * The Content-Security-Policy this application can actually run under.
 *
 * TanStack Start server-renders and then hydrates: the HTML carries
 * inline bootstrap script and the router's serialized state, and Vite's
 * CSS pipeline emits inline style attributes. So `'unsafe-inline'` is
 * required for script and style TODAY, and pretending otherwise would
 * mean shipping a policy that breaks the site — a CSP that gets
 * switched off in a hurry protects nobody.
 *
 * What the policy does buy, and buys honestly:
 *   - `default-src 'self'` — no third-party origin can be fetched at
 *     all, which is consistent with a platform that has no CDN, no
 *     analytics and no external fonts;
 *   - `frame-ancestors 'none'` — the modern, header-based clickjacking
 *     defence (X-Frame-Options below is the legacy twin);
 *   - `object-src 'none'` and `base-uri 'self'` — two classic
 *     injection escape hatches closed;
 *   - `form-action 'self'` — a form cannot be repointed at another
 *     origin;
 *   - `media-src 'self'` — a recorded prayer plays only from this
 *     origin, never from a public bucket or CDN;
 *   - `upgrade-insecure-requests` in production.
 *
 * Tightening script-src to nonces or hashes is real work in the
 * framework's rendering path, and it is named in the runbook as
 * outstanding rather than quietly claimed.
 */
export function contentSecurityPolicy(options: SecurityHeaderOptions): string {
  // Phase One media delivery: the authenticated Prayer Room proof,
  // then a signed private GET of at most five minutes. Local storage is
  // proxied through this origin; a remote provider is redirected to,
  // and that provider's EXACT origin is the only external source
  // allowed to play. Nothing else — no wildcard, no CDN.
  const mediaSources = ["'self'", 'blob:']
  const mediaOrigin = mediaOriginFromEndpoint(options.mediaOrigin)
  if (mediaOrigin) mediaSources.push(mediaOrigin)
  const directives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `media-src ${mediaSources.join(' ')}`,
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "worker-src 'self' blob:",
  ]
  if (options.isProduction) directives.push('upgrade-insecure-requests')
  return directives.join('; ')
}

/**
 * Permissions-Policy: everything this application does not use is
 * turned off.
 *
 * It plays a recorded video and takes typed input. It never asks for a
 * camera, a microphone, a location, a payment handler or a sensor — so
 * neither may anything embedded in it, which is the point of denying
 * capabilities you do not need rather than only the ones you fear.
 */
const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'autoplay=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=()',
  'fullscreen=(self)',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'picture-in-picture=(self)',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ')

export function securityHeaders(
  options: SecurityHeaderOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': contentSecurityPolicy(options),
    // Never let a browser second-guess a declared type — the defence
    // that stops an uploaded file being executed as script.
    'X-Content-Type-Options': 'nosniff',
    // Legacy twin of frame-ancestors, for clients that predate CSP 2.
    'X-Frame-Options': 'DENY',
    // Send the origin cross-site and the full path same-origin: an
    // appointment publicId in a path must never travel to a third party
    // in a Referer.
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': PERMISSIONS_POLICY,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Permitted-Cross-Domain-Policies': 'none',
  }
  if (options.isProduction && options.isHttps) {
    // Two years, subdomains included. NOT sent in development or over
    // plain HTTP: a browser that is told this remembers it, and a
    // developer who accidentally pins localhost to HTTPS has a bad
    // afternoon.
    headers['Strict-Transport-Security'] =
      'max-age=63072000; includeSubDomains'
  }
  return headers
}

/**
 * Applies the headers to a response WITHOUT overwriting anything a
 * handler set deliberately.
 *
 * The direction matters: the Prayer Room's media response already
 * chooses its own caching and framing headers as part of an
 * authorization decision, and a blanket pass that clobbered them would
 * silently undo it.
 */
function isHeaderOptions(
  value: SecurityHeaderOptions | Record<string, string>,
): value is SecurityHeaderOptions {
  return typeof (value as SecurityHeaderOptions).isProduction === 'boolean'
}

export function withSecurityHeaders(
  response: Response,
  options: SecurityHeaderOptions | Record<string, string>,
): Response {
  // Accepts an ALREADY-BUILT header map as well as options, because
  // this runs on every response — including every static asset — and
  // rebuilding the same constant map per request is pure waste. The
  // server entry builds it once at startup.
  const built = isHeaderOptions(options)
    ? securityHeaders(options)
    : options
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(built)) {
    if (!headers.has(name)) headers.set(name, value)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
