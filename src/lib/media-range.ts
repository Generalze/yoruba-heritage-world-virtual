/**
 * HTTP byte-range handling for private media playback (Phase One,
 * Step 18).
 *
 * Kept as a pure function of (byteSize, header) so the range algebra —
 * the part that is easy to get subtly wrong and that a browser will
 * exercise relentlessly during scrubbing — is testable without a
 * server, a session or a database.
 *
 * Implements the single-range subset of RFC 9110 §14 that video
 * playback actually uses:
 *   bytes=START-END   an explicit window
 *   bytes=START-      from START to the end
 *   bytes=-SUFFIX     the last SUFFIX bytes
 * Anything else — multiple ranges, a non-`bytes` unit, a malformed or
 * unsatisfiable window — is refused rather than guessed at.
 */

export type MediaRangeResolution =
  | { kind: 'FULL' }
  | { kind: 'PARTIAL'; start: number; end: number; length: number }
  | { kind: 'UNSATISFIABLE' }

/**
 * Resolves a Range header against a known object size.
 *
 * A MISSING header is a full response, not an error. A header we do not
 * fully understand is UNSATISFIABLE rather than silently downgraded to
 * a full response: a client that asked for part of a file and got all
 * of it with a 200 would mis-seek, and one that asked for something
 * nonsensical deserves a straight answer.
 */
export function resolveMediaRange(
  byteSize: number,
  rangeHeader: string | null,
): MediaRangeResolution {
  if (rangeHeader == null || rangeHeader.trim() === '') return { kind: 'FULL' }
  if (byteSize <= 0) return { kind: 'UNSATISFIABLE' }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!match) return { kind: 'UNSATISFIABLE' }
  const [, rawStart, rawEnd] = match

  // bytes=-SUFFIX — the final SUFFIX bytes.
  if (rawStart === '') {
    if (rawEnd === '') return { kind: 'UNSATISFIABLE' }
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return { kind: 'UNSATISFIABLE' }
    }
    const start = Math.max(0, byteSize - suffix)
    return {
      kind: 'PARTIAL',
      start,
      end: byteSize - 1,
      length: byteSize - start,
    }
  }

  const start = Number(rawStart)
  if (!Number.isSafeInteger(start) || start < 0 || start >= byteSize) {
    return { kind: 'UNSATISFIABLE' }
  }
  // bytes=START- — open ended.
  if (rawEnd === '') {
    return {
      kind: 'PARTIAL',
      start,
      end: byteSize - 1,
      length: byteSize - start,
    }
  }
  const requestedEnd = Number(rawEnd)
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) {
    return { kind: 'UNSATISFIABLE' }
  }
  // An end past the object is clamped, per RFC 9110 — that is a normal
  // request, not a bad one.
  const end = Math.min(requestedEnd, byteSize - 1)
  return { kind: 'PARTIAL', start, end, length: end - start + 1 }
}

/** Headers every private media response carries, whatever its status.
 * `private, no-store` keeps a shared cache or a browser's disk cache
 * from retaining a prayer video, and `nosniff` stops a client
 * second-guessing the declared type. */
export function privateMediaHeaders(mimeType: string): Record<string, string> {
  return {
    'Content-Type': mimeType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    // The object is private and per-user: never let a shared cache key
    // it by URL alone.
    Vary: 'Cookie',
  }
}

/**
 * Builds the playback response for already-verified bytes.
 *
 * The bytes handed in are the ones the caller just proved (existence,
 * size, mime and SHA-256); this function only slices and labels them.
 * It never names a file, a path, an object key or a provider — a
 * response body is media and nothing else.
 */
export function buildPrivateMediaResponse(
  bytes: Uint8Array,
  mimeType: string,
  rangeHeader: string | null,
): Response {
  const headers = privateMediaHeaders(mimeType)
  const resolved = resolveMediaRange(bytes.length, rangeHeader)
  if (resolved.kind === 'UNSATISFIABLE') {
    return new Response(null, {
      status: 416,
      headers: {
        ...headers,
        'Content-Range': `bytes */${String(bytes.length)}`,
        'Content-Length': '0',
      },
    })
  }
  if (resolved.kind === 'FULL') {
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: { ...headers, 'Content-Length': String(bytes.length) },
    })
  }
  const slice = bytes.subarray(resolved.start, resolved.end + 1)
  return new Response(slice as unknown as BodyInit, {
    status: 206,
    headers: {
      ...headers,
      'Content-Length': String(resolved.length),
      'Content-Range': `bytes ${String(resolved.start)}-${String(resolved.end)}/${String(bytes.length)}`,
    },
  })
}
