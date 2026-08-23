import type { ReactNode } from 'react'

/**
 * Reusable UI primitives (Step 21A) — the shared visual vocabulary of
 * the platform, expressed with the semantic tokens from styles.css.
 *
 * Styling decisions follow docs/design/UI_VISUAL_DIRECTION.md: warm
 * light surfaces with thin sand borders and soft shadows, deep-brown
 * immersive surfaces, gold as a restrained accent, serif display type
 * for editorial/spiritual moments and the interface sans for
 * everything functional. Components here are purely presentational —
 * no data fetching, no provider logic, no business rules.
 */

// --- Buttons -----------------------------------------------------------------

export type ButtonVariant =
  | 'primary' /* muted gold fill, dark text — the one main CTA        */
  | 'secondary' /* quiet outline on light grounds                     */
  | 'secondary-on-dark' /* quiet outline on night grounds             */
  | 'ghost' /* text-only, for tertiary actions                        */

export type ButtonSize = 'md' | 'lg'

const BUTTON_VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-gold text-night font-semibold hover:bg-gold-bright active:bg-gold-bright',
  secondary:
    'border border-line-strong text-ink font-semibold hover:border-gold-deep hover:text-gold-deep',
  'secondary-on-dark':
    'border border-night-line text-cream-on-night font-semibold hover:border-gold hover:text-gold-bright',
  ghost: 'text-gold-deep font-semibold hover:text-ink underline-offset-4 hover:underline',
}

const BUTTON_SIZE_CLASSES: Record<ButtonSize, string> = {
  md: 'px-5 py-2.5 text-sm',
  lg: 'px-7 py-3 text-base',
}

/**
 * Class recipe shared by real <button> elements and router <Link>s —
 * links styled as buttons keep their semantics and keyboard behavior.
 */
export function buttonClass(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
): string {
  return [
    'inline-flex items-center justify-center gap-2 rounded-md transition-colors',
    BUTTON_SIZE_CLASSES[size],
    BUTTON_VARIANT_CLASSES[variant],
  ].join(' ')
}

export function Button({
  variant = 'primary',
  size = 'md',
  type = 'button',
  disabled,
  onClick,
  children,
}: {
  variant?: ButtonVariant
  size?: ButtonSize
  type?: 'button' | 'submit'
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`${buttonClass(variant, size)} disabled:cursor-not-allowed disabled:opacity-60`}
    >
      {children}
    </button>
  )
}

// --- Layout ------------------------------------------------------------------

/** Standard readable page column. */
export function Container({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`mx-auto w-full max-w-6xl px-6 ${className}`}>
      {children}
    </div>
  )
}

/**
 * Kicker + serif display heading + optional intro — the editorial
 * opening of a landing/page section.
 */
export function SectionHeading({
  kicker,
  title,
  intro,
  onDark = false,
  align = 'start',
  headingLevel = 'h2',
}: {
  kicker?: string
  title: string
  intro?: ReactNode
  onDark?: boolean
  align?: 'start' | 'center'
  headingLevel?: 'h1' | 'h2'
}) {
  const Heading = headingLevel
  const alignClass = align === 'center' ? 'text-center' : 'text-left'
  return (
    <div className={`max-w-3xl ${alignClass} ${align === 'center' ? 'mx-auto' : ''}`}>
      {kicker ? (
        <p
          className={`text-xs font-semibold tracking-[0.28em] uppercase ${
            onDark ? 'text-gold-bright' : 'text-gold-deep'
          }`}
        >
          {kicker}
        </p>
      ) : null}
      <Heading
        className={`font-display mt-3 text-3xl leading-tight text-balance sm:text-4xl ${
          onDark ? 'text-cream-on-night' : 'text-ink'
        }`}
      >
        {title}
      </Heading>
      {intro ? (
        <p
          className={`mt-4 text-base leading-relaxed ${
            onDark ? 'text-cream-soft-on-night' : 'text-ink-soft'
          }`}
        >
          {intro}
        </p>
      ) : null}
    </div>
  )
}

// --- Surfaces ----------------------------------------------------------------

/** Warm light card: thin sand border, soft shadow, generous padding. */
export function Card({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`rounded-lg border border-line bg-surface-raised p-6 shadow-[0_1px_3px_rgba(43,32,24,0.08)] ${className}`}
    >
      {children}
    </div>
  )
}

/** Compact text chip. Never the only carrier of a status — always text. */
export function Badge({
  children,
  onDark = false,
}: {
  children: ReactNode
  onDark?: boolean
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-xs ${
        onDark
          ? 'border-night-line text-cream-soft-on-night'
          : 'border-line-strong text-ink-soft'
      }`}
    >
      {children}
    </span>
  )
}

// --- Decoration --------------------------------------------------------------

/**
 * Small geometric brand mark: an eight-pointed lattice star. Decorative
 * geometry in the approved palette — it carries no sacred meaning and
 * is always hidden from assistive technology (the adjacent wordmark
 * carries the name).
 */
export function BrandMark({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <g fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M16 2 30 16 16 30 2 16Z" />
        <path d="M16 8 24 16 16 24 8 16Z" />
        <circle cx="16" cy="16" r="2.6" fill="currentColor" stroke="none" />
      </g>
    </svg>
  )
}

/** Thin centered gold ornament separating editorial sections. */
export function PatternDivider({ onDark = false }: { onDark?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={`flex items-center justify-center gap-3 ${
        onDark ? 'text-gold' : 'text-gold-deep'
      }`}
    >
      <span
        className={`h-px w-16 ${onDark ? 'bg-night-line' : 'bg-line-strong'}`}
      />
      <BrandMark className="h-4 w-4" />
      <span
        className={`h-px w-16 ${onDark ? 'bg-night-line' : 'bg-line-strong'}`}
      />
    </div>
  )
}

// --- Accessibility -----------------------------------------------------------

/**
 * First focusable element on chrome-bearing pages: lets keyboard and
 * screen-reader users jump past the navigation. The target page must
 * render an element with id="main-content".
 */
export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only z-50 rounded-md bg-gold font-semibold text-night focus-visible:not-sr-only focus-visible:absolute focus-visible:top-3 focus-visible:left-3 focus-visible:px-4 focus-visible:py-2"
    >
      Skip to main content
    </a>
  )
}

// --- Icons (inline, decorative unless labelled by the caller) ---------------

export function IconMenu({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3 5.5h14M3 10h14M3 14.5h14"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

export function IconClose({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="m5 5 10 10M15 5 5 15"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

export function IconArrow({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2.5 8h11m0 0L9 3.5M13.5 8 9 12.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}

// --- Forms -------------------------------------------------------------------

/** Shared control styling for inputs and selects on light surfaces. */
export const inputClass =
  'w-full rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink placeholder-ink-soft/70 focus:border-gold-deep focus:outline-none'

/**
 * Label + control. The label WRAPS its control, so the association
 * needs no id plumbing and clicking the label always focuses the
 * field — no placeholder-as-label anywhere (UI direction §6).
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint ? (
        <span className="mt-1.5 block text-xs text-ink-soft">{hint}</span>
      ) : null}
    </label>
  )
}

/** Bounded, announced error. Renders nothing when there is no message. */
export function ErrorNotice({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p
      role="alert"
      className="rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-alert"
    >
      {message}
    </p>
  )
}

export type NoticeTone = 'affirm' | 'caution' | 'neutral'

const NOTICE_TONE_CLASSES: Record<NoticeTone, string> = {
  affirm: 'border-affirm/40 bg-affirm/10 text-affirm',
  caution: 'border-caution/40 bg-caution/10 text-caution',
  neutral: 'border-line bg-surface text-ink-soft',
}

/**
 * Status banner. The TONE never carries the meaning on its own — the
 * message text always states it outright (UI direction §9).
 */
export function Notice({
  tone = 'neutral',
  children,
}: {
  tone?: NoticeTone
  children: ReactNode
}) {
  return (
    <div
      className={`rounded-md border px-4 py-3 text-sm leading-relaxed ${NOTICE_TONE_CLASSES[tone]}`}
    >
      {children}
    </div>
  )
}

// --- Progress ----------------------------------------------------------------

/**
 * Completion dial. The ring is decoration: the same figure is printed
 * inside it and restated in the surrounding copy, so nothing depends
 * on reading an arc (or a colour). Static — no animation to suppress
 * under reduced motion.
 */
export function ProgressRing({
  done,
  total,
  className = 'h-24 w-24',
}: {
  done: number
  total: number
  className?: string
}) {
  const safeTotal = total > 0 ? total : 1
  const ratio = Math.max(0, Math.min(1, done / safeTotal))
  const percent = Math.round(ratio * 100)
  const radius = 42
  const circumference = 2 * Math.PI * radius
  return (
    <span className={`relative inline-flex shrink-0 ${className}`}>
      <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="8"
          className="text-line"
        />
        {/* Omitted entirely at zero: a round line cap with no length
            still paints a dot, which would read as progress. */}
        {ratio > 0 ? (
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${circumference * ratio} ${circumference}`}
            transform="rotate(-90 50 50)"
            className="text-gold"
          />
        ) : null}
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-xl text-ink">{percent}%</span>
      </span>
    </span>
  )
}

/**
 * Checklist row. State is carried by an explicit word ("Added" /
 * "Still needed") as well as the mark, never by colour alone.
 */
export function CheckItem({ label, done }: { label: string; done: boolean }) {
  return (
    <li className="flex items-center justify-between gap-4 py-1.5">
      <span className="flex items-center gap-2.5 text-sm text-ink">
        <span
          aria-hidden="true"
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[0.7rem] ${
            done
              ? 'border-affirm bg-affirm/15 text-affirm'
              : 'border-line-strong text-ink-soft'
          }`}
        >
          {done ? '✓' : ''}
        </span>
        {label}
      </span>
      <span
        className={`shrink-0 text-xs ${done ? 'text-affirm' : 'text-ink-soft'}`}
      >
        {done ? 'Added' : 'Still needed'}
      </span>
    </li>
  )
}
