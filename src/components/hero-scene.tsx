/**
 * Hero backdrop (Step 21A fidelity pass): a full-bleed, candle-lit
 * sanctuary interior used as the hero BACKGROUND, matching the
 * approved reference's composition — deep chiaroscuro, a carved wall
 * disc, vessels and carved forms receding into shadow, a warm pool of
 * candlelight, heavy vignette — with the hero copy overlaid on a dark
 * scrim at the left, exactly as the reference does it.
 *
 * ORIGINAL ARTWORK, not a crop of the showcase screenshot (UI
 * direction §13). Deliberately NO human figure: a stylised face reads
 * as caricature beside photography, and the reference's real subject
 * is the ATMOSPHERE. Everything is rendered with soft gradients,
 * blur and bokeh so it behaves like a photographic backdrop rather
 * than flat vector art.
 *
 * GOVERNANCE: material culture and light only. The wall disc and
 * carved forms are decorative geometry — no ritual, offering,
 * doctrine or deity iconography is depicted, and nothing here may be
 * labelled an authentic spiritual symbol (§5/§11).
 *
 * SWAPPING IN A PHOTOGRAPH: this component is the fallback. When an
 * approved, rights-cleared photograph exists, drop it in `public/`
 * and render it in place of <HeroBackdrop /> in src/routes/index.tsx
 * — the surrounding scrim/composition needs no other change, and the
 * CSP already allows same-origin images.
 */
/** Candle cluster geometry, shared by the glow and wax passes. */
const CANDLES = [
  { x: 812, y: 606, w: 40, h: 138 },
  { x: 872, y: 636, w: 34, h: 108 },
  { x: 926, y: 660, w: 28, h: 84 },
  { x: 762, y: 668, w: 24, h: 76 },
] as const

export function HeroBackdrop({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1600 900"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <defs>
        <linearGradient id="hb-wall" x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor="#2a1a0f" />
          <stop offset="0.5" stopColor="#1d1108" />
          <stop offset="1" stopColor="#0d0704" />
        </linearGradient>
        <radialGradient id="hb-keylight" cx="0.63" cy="0.72" r="0.6">
          <stop offset="0" stopColor="#ffd08a" stopOpacity="0.92" />
          <stop offset="0.22" stopColor="#e8a94f" stopOpacity="0.55" />
          <stop offset="0.5" stopColor="#c08331" stopOpacity="0.26" />
          <stop offset="0.78" stopColor="#8a5c1e" stopOpacity="0.1" />
          <stop offset="1" stopColor="#8a5c1e" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="hb-halo" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#fff0cf" stopOpacity="1" />
          <stop offset="0.32" stopColor="#ffc978" stopOpacity="0.62" />
          <stop offset="1" stopColor="#e09a3a" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="hb-flame" cx="0.5" cy="0.72" r="0.7">
          <stop offset="0" stopColor="#fffaf0" />
          <stop offset="0.4" stopColor="#ffd98a" />
          <stop offset="1" stopColor="#e8892c" stopOpacity="0.85" />
        </radialGradient>
        <linearGradient id="hb-brass" x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0" stopColor="#c99a4e" />
          <stop offset="0.45" stopColor="#8a6021" />
          <stop offset="1" stopColor="#3a2810" />
        </linearGradient>
        <linearGradient id="hb-disc" x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="#7a5522" />
          <stop offset="0.5" stopColor="#4a3116" />
          <stop offset="1" stopColor="#241708" />
        </linearGradient>
        <radialGradient id="hb-vignette" cx="0.58" cy="0.62" r="0.78">
          <stop offset="0" stopColor="#0d0704" stopOpacity="0" />
          <stop offset="0.55" stopColor="#0d0704" stopOpacity="0" />
          <stop offset="0.82" stopColor="#0b0503" stopOpacity="0.6" />
          <stop offset="1" stopColor="#080402" stopOpacity="0.95" />
        </radialGradient>
        <filter id="hb-blur-s" x="-70%" y="-70%" width="240%" height="240%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
        <filter id="hb-blur-m" x="-70%" y="-70%" width="240%" height="240%">
          <feGaussianBlur stdDeviation="26" />
        </filter>
        <filter id="hb-blur-l" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="60" />
        </filter>
        <filter id="hb-grain">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.9"
            numOctaves="3"
            result="noise"
          />
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncA type="linear" slope="0.055" />
          </feComponentTransfer>
        </filter>
      </defs>

      {/* Back wall */}
      <rect width="1600" height="900" fill="url(#hb-wall)" />

      {/* Carved wall disc — decorative concentric geometry, softened
          so it sits BEHIND the light rather than competing with it */}
      <g
        transform="translate(1010 330)"
        filter="url(#hb-blur-s)"
        opacity="0.85"
      >
        <circle r="196" fill="url(#hb-disc)" />
        <circle r="196" fill="none" stroke="#c8933c" strokeOpacity="0.62" strokeWidth="8" />
        <circle r="162" fill="none" stroke="#e0ab54" strokeOpacity="0.42" strokeWidth="3" />
        <circle r="118" fill="none" stroke="#e0ab54" strokeOpacity="0.5" strokeWidth="5" />
        <circle r="54" fill="none" stroke="#f0bf68" strokeOpacity="0.58" strokeWidth="4" />
        <g stroke="#e0ab54" strokeOpacity="0.45" strokeWidth="4">
          {Array.from({ length: 16 }, (_, index) => {
            const angle = (index * Math.PI * 2) / 16
            return (
              <line
                key={index}
                x1={Math.cos(angle) * 122}
                y1={Math.sin(angle) * 122}
                x2={Math.cos(angle) * 160}
                y2={Math.sin(angle) * 160}
              />
            )
          })}
        </g>
        <g fill="#e0ab54" fillOpacity="0.4">
          {Array.from({ length: 8 }, (_, index) => {
            const angle = (index * Math.PI * 2) / 8 + Math.PI / 8
            return (
              <circle
                key={index}
                cx={Math.cos(angle) * 86}
                cy={Math.sin(angle) * 86}
                r="13"
              />
            )
          })}
        </g>
      </g>

      {/* Carved column forms receding into shadow (abstract, faceless) */}
      <g filter="url(#hb-blur-m)" opacity="0.85">
        <path
          d="M1318 900 V430 q0 -46 34 -46 q34 0 34 46 V900 Z"
          fill="#20140a"
        />
        <path
          d="M1404 900 V486 q0 -38 28 -38 q28 0 28 38 V900 Z"
          fill="#190f07"
        />
        <path d="M1246 900 V520 q0 -30 22 -30 q22 0 22 30 V900 Z" fill="#1c1109" />
      </g>

      {/* Plinth + vessels, lit from the candles below-left */}
      <g filter="url(#hb-blur-s)">
        <rect x="792" y="596" width="470" height="26" rx="8" fill="#2a1a0f" />
        <path d="M842 596 q6 -78 54 -78 q48 0 54 78 Z" fill="url(#hb-brass)" />
        <ellipse cx="896" cy="520" rx="54" ry="13" fill="#f0c06e" opacity="0.85" />
        <path
          d="M988 596 v-96 q0 -34 26 -34 q26 0 26 34 v96 Z"
          fill="url(#hb-brass)"
        />
        <path d="M1092 596 q4 -62 40 -62 q36 0 40 62 Z" fill="#5c3f17" />
      </g>

      {/* Warm key light from the candle cluster */}
      <ellipse cx="1000" cy="650" rx="760" ry="620" fill="url(#hb-keylight)" />

      {/* Foreground table edge */}
      <path d="M640 742 H1600 V900 H600 Z" fill="#150c06" />
      <path
        d="M640 742 H1600"
        stroke="#8a6021"
        strokeOpacity="0.35"
        strokeWidth="3"
      />

      {/* Candle cluster — the only crisp elements, as in a photograph
          where the light source holds focus */}
      <g>
        {/* Ambient bloom, then per-flame glow — ALL behind the wax, so
            the candles stay crisp instead of hiding in their own light */}
        <ellipse
          cx="866"
          cy="628"
          rx="300"
          ry="225"
          fill="url(#hb-halo)"
          opacity="0.42"
          filter="url(#hb-blur-l)"
        />
        {CANDLES.map((candle) => (
          <ellipse
            key={`glow-${candle.x}`}
            cx={candle.x + candle.w / 2}
            cy={candle.y - 30}
            rx={candle.w * 1.5}
            ry={candle.w * 1.9}
            fill="#ffcf86"
            opacity="0.42"
            filter="url(#hb-blur-s)"
          />
        ))}
        {CANDLES.map((candle) => (
          <g key={candle.x}>
            <rect
              x={candle.x}
              y={candle.y}
              width={candle.w}
              height={candle.h}
              rx={candle.w / 2.4}
              fill="#f6ead0"
            />
            <rect
              x={candle.x + candle.w * 0.6}
              y={candle.y}
              width={candle.w * 0.4}
              height={candle.h}
              rx={candle.w / 3}
              fill="#8a6b3c"
              opacity="0.5"
            />
            <ellipse
              cx={candle.x + candle.w / 2}
              cy={candle.y + 3}
              rx={candle.w / 2}
              ry={candle.w / 6}
              fill="#fff6e2"
            />
            <path
              d={`M${candle.x + candle.w / 2} ${candle.y - 46}
                  q${candle.w * 0.36} ${candle.w * 0.58} 0 ${candle.w * 1.05}
                  q-${candle.w * 0.36} -${candle.w * 0.47} 0 -${candle.w * 1.05} Z`}
              fill="url(#hb-flame)"
            />
          </g>
        ))}
      </g>

      {/* Bokeh — distant light points, the photographic tell */}
      <g filter="url(#hb-blur-s)">
        {[
          { cx: 1268, cy: 268, r: 20, o: 0.24 },
          { cx: 1382, cy: 372, r: 14, o: 0.18 },
          { cx: 1188, cy: 176, r: 11, o: 0.16 },
          { cx: 1462, cy: 250, r: 17, o: 0.14 },
          { cx: 748, cy: 300, r: 13, o: 0.12 },
          { cx: 1528, cy: 452, r: 10, o: 0.12 },
        ].map((dot) => (
          <circle
            key={`${dot.cx}-${dot.cy}`}
            cx={dot.cx}
            cy={dot.cy}
            r={dot.r}
            fill="#ffcf8a"
            opacity={dot.o}
          />
        ))}
      </g>

      {/* Light pooling across the table */}
      <ellipse
        cx="900"
        cy="782"
        rx="430"
        ry="84"
        fill="#f0b458"
        opacity="0.14"
        filter="url(#hb-blur-m)"
      />

      {/* Atmospheric haze + vignette + grain */}
      <rect width="1600" height="900" fill="url(#hb-vignette)" />
      <rect width="1600" height="900" filter="url(#hb-grain)" opacity="0.5" />
    </svg>
  )
}
