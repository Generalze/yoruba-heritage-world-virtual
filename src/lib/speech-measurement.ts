/**
 * SPEECH MEASUREMENT — the two pure decisions a measurement report makes.
 *
 * Both live here rather than inside the measurement script because the
 * script is a top-level-await executable: importing it opens a database
 * connection and starts doing work, so nothing inside it can be unit
 * tested. These two rules decide what a paid measurement MEANS, and a
 * rule that decides meaning has to be provable on its own.
 *
 * Neither function touches the filesystem, the network or the clock.
 */

// --- Variance banding --------------------------------------------------------

export type DurationVarianceBand = 'GREEN' | 'AMBER' | 'RED'

/**
 * The thresholds locked at YA-0, before any audio existed to judge.
 *
 * They are stated as ABSOLUTE variance — magnitude, not direction —
 * because a block that comes back 30% SHORT than its authored budget is
 * exactly as much of a finding as one that comes back 30% long. The
 * budgets were written before anyone had heard the Yorùbá spoken; the
 * band says how far the writing was from the speech, either way.
 *
 * These numbers are not tuning knobs. They were agreed in advance so
 * that the first measurement could not be graded against a threshold
 * chosen after seeing it.
 */
export const VARIANCE_BAND_GREEN_MAX_PERCENT = 15
export const VARIANCE_BAND_AMBER_MAX_PERCENT = 40

/**
 * Bands one measurement against its authored budget.
 *
 * TAKES THE PERCENTAGE THE REPORT PUBLISHES, deliberately. If this
 * classified a raw value while the report printed a rounded one, a
 * report could read "15.0% — AMBER" and look like a defect to the
 * person holding it. The band and the number a reader checks it against
 * are the same number.
 *
 * Returns null when there is no usable budget to compare against. A
 * missing budget is not GREEN; it is unclassifiable, and the report
 * says so rather than implying a pass.
 */
export function classifyDurationVariance(
  deltaPercent: number | null,
): DurationVarianceBand | null {
  if (deltaPercent === null || !Number.isFinite(deltaPercent)) return null
  const magnitude = Math.abs(deltaPercent)
  if (magnitude <= VARIANCE_BAND_GREEN_MAX_PERCENT) return 'GREEN'
  if (magnitude <= VARIANCE_BAND_AMBER_MAX_PERCENT) return 'AMBER'
  return 'RED'
}

// --- Naming the evidence file ------------------------------------------------

export type AudioFileExtensionResult =
  | { ok: true; extension: string }
  | { ok: false; reasonCode: 'audio_mime_type_unrecognised' }

/**
 * The extension used when the returned MIME type is not one we know.
 *
 * NEUTRAL ON PURPOSE. The alternative — naming every artifact `.wav`
 * because the provider usually returns WAV — writes a claim about the
 * bytes into the filename, and a mislabelled file is a small lie that
 * outlives the run that told it.
 */
export const NEUTRAL_AUDIO_EXTENSION = 'bin'

/**
 * MIME types this platform is willing to name.
 *
 * Kept separate from the private table inside media-probe, which names
 * a SCRATCH file for a prober that sniffs content anyway. This one
 * names evidence somebody keeps.
 */
const AUDIO_FILE_EXTENSIONS: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/webm': 'weba',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
}

/**
 * Derives a file extension from the MIME type the provider actually
 * returned — never from what we expected it to return.
 *
 * FAILS CLOSED ON THE NAME, not on the bytes. An unrecognised type
 * returns a refusal so the caller records WHY the artifact is not
 * named; the caller still writes the file, under the neutral
 * extension. Discarding paid audio because we could not name it would
 * be the worse mistake.
 */
export function audioFileExtensionFor(mimeType: string): AudioFileExtensionResult {
  // `audio/wav; charset=binary` is the same type as `audio/wav`.
  const normalised = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  const extension = AUDIO_FILE_EXTENSIONS[normalised]
  if (extension === undefined) {
    return { ok: false, reasonCode: 'audio_mime_type_unrecognised' }
  }
  return { ok: true, extension }
}
