/**
 * Decorative motif set (Step 21A high-fidelity pass): small vector
 * emblems giving cards and medallions the reference's premium visual
 * anchors — candle light, vessels, beadwork, woven lattice.
 *
 * ALL of it is decorative geometry and material-culture abstraction in
 * the approved palette (UI_VISUAL_DIRECTION.md §5/§11): nothing here
 * is, or may be labeled as, an authentic spiritual symbol, deity
 * iconography, or ritual depiction. Every motif is aria-hidden; the
 * adjacent text carries the meaning.
 */

export type MotifName = 'flame' | 'vessel' | 'beads' | 'lattice'

const MOTIF_ORDER: ReadonlyArray<MotifName> = [
  'flame',
  'vessel',
  'beads',
  'lattice',
]

/** Stable motif for a list index — purely presentational variety. */
export function motifForIndex(index: number): MotifName {
  return MOTIF_ORDER[((index % MOTIF_ORDER.length) + MOTIF_ORDER.length) % MOTIF_ORDER.length]
}

function MotifPaths({ name }: { name: MotifName }) {
  switch (name) {
    case 'flame':
      return (
        <>
          <path
            d="M16 5 q6 8 0 14 q-6 -6 0 -14 Z"
            fill="currentColor"
            opacity="0.9"
          />
          <rect x="12.5" y="19" width="7" height="7" rx="1.4" fill="none" />
          <path d="M9 27.5 h14" />
        </>
      )
    case 'vessel':
      return (
        <>
          <ellipse cx="16" cy="12" rx="6.5" ry="2.4" fill="none" />
          <path d="M9.5 12 q1 10 6.5 10 q5.5 0 6.5 -10" fill="none" />
          <path d="M11 25.5 h10" />
          <path d="M16 5.5 v3" />
        </>
      )
    case 'beads':
      return (
        <>
          <path
            d="M7 12 q9 12 18 0"
            fill="none"
            strokeDasharray="0.1 4.6"
            strokeWidth="3.2"
          />
          <path
            d="M9 17 q7 10 14 0"
            fill="none"
            strokeDasharray="0.1 4.2"
            strokeWidth="2.8"
          />
        </>
      )
    case 'lattice':
      return (
        <>
          <path d="M16 5 27 16 16 27 5 16Z" fill="none" />
          <path d="M16 10.5 21.5 16 16 21.5 10.5 16Z" fill="none" />
          <circle cx="16" cy="16" r="1.6" fill="currentColor" />
        </>
      )
  }
}

/** Small square motif tile — the thumbnail anchor on compact cards. */
export function MotifTile({
  name,
  className = 'h-14 w-14',
}: {
  name: MotifName
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={`texture-night flex shrink-0 items-center justify-center rounded-md border border-night-line bg-night text-gold ${className}`}
    >
      <svg
        viewBox="0 0 32 32"
        className="h-7 w-7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
        focusable="false"
      >
        <MotifPaths name={name} />
      </svg>
    </span>
  )
}

/** Gold-ringed circular medallion — a SHARED decorative discovery
 * anchor echoing the reference's circular treatment. Deliberately NOT
 * an emblem: every Sacred House receives the SAME neutral geometric
 * mark, because assigning distinct marks to real spiritual
 * institutions would fabricate identity/insignia facts nobody
 * approved (UI direction §5/§13). Approved House-supplied assets, if
 * they ever exist, would replace this — never a frontend invention. */
export function EmblemMedallion({
  name,
  className = 'h-20 w-20',
}: {
  name: MotifName
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full border-2 border-gold/60 bg-night-raised text-gold shadow-[0_0_0_5px_rgba(194,145,63,0.12)] ${className}`}
    >
      <svg
        viewBox="0 0 32 32"
        className="h-9 w-9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
        focusable="false"
      >
        <MotifPaths name={name} />
      </svg>
    </span>
  )
}

/** Serif-initial medallion for deity profile cards. The glyph is the
 * profile name's own first grapheme (diacritics preserved) — plain
 * typography, never an invented symbol for the deity. */
export function InitialMedallion({ name }: { name: string }) {
  let initial = name.trim().charAt(0)
  try {
    const segmenter = new Intl.Segmenter('yo', { granularity: 'grapheme' })
    const first = segmenter.segment(name.trim())[Symbol.iterator]().next()
    if (!first.done) initial = first.value.segment
  } catch {
    // grapheme segmentation unavailable — the first code unit is fine
  }
  return (
    <span
      aria-hidden="true"
      className="font-display flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-gold/50 bg-surface text-xl text-gold-deep"
    >
      {initial}
    </span>
  )
}
