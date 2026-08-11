/**
 * Hero tableau (Step 21A high-fidelity pass): a standalone illustrated
 * scene reproducing the APPROVED reference hero's composition — a
 * dignified elder in flowing cream robes seated in a candle-lit,
 * deep-brown sanctuary interior with brass vessels — as an original
 * layered SVG in the platform palette.
 *
 * This is an ORIGINAL asset, not a crop of the showcase screenshot
 * (docs/design/UI_VISUAL_DIRECTION.md §13 forbids copying showcase
 * pixels/values). It depicts atmosphere and material culture only:
 * no specific ritual, offering, doctrine or instruction is shown or
 * implied, and nothing here is labeled as an authentic spiritual
 * symbol. Self-contained vector art keeps the CSP happy (no external
 * image) and stays crisp at every size.
 */
export function HeroTableau({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="70 190 600 690"
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label="Illustration of a candle-lit interior where an elder in flowing cream robes sits beside brass vessels."
      className={className}
    >
      <defs>
        <linearGradient id="ht-room" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#241811" />
          <stop offset="0.55" stopColor="#1b1009" />
          <stop offset="1" stopColor="#120a05" />
        </linearGradient>
        <radialGradient id="ht-glow" cx="0.42" cy="0.72" r="0.65">
          <stop offset="0" stopColor="#f0b95c" stopOpacity="0.5" />
          <stop offset="0.35" stopColor="#c2913f" stopOpacity="0.22" />
          <stop offset="1" stopColor="#c2913f" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="ht-arch-glow" cx="0.5" cy="0.85" r="0.75">
          <stop offset="0" stopColor="#a06b2c" stopOpacity="0.5" />
          <stop offset="1" stopColor="#a06b2c" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="ht-robe" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stopColor="#f2e9d8" />
          <stop offset="0.6" stopColor="#ddcdae" />
          <stop offset="1" stopColor="#bfa980" />
        </linearGradient>
        <linearGradient id="ht-robe-shade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#8a6220" stopOpacity="0" />
          <stop offset="1" stopColor="#5c3f16" stopOpacity="0.35" />
        </linearGradient>
        <linearGradient id="ht-skin" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6b4226" />
          <stop offset="1" stopColor="#3c2414" />
        </linearGradient>
        <linearGradient id="ht-brass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e3b365" />
          <stop offset="0.5" stopColor="#b07f33" />
          <stop offset="1" stopColor="#6d4a1a" />
        </linearGradient>
        <linearGradient id="ht-wood" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3a2413" />
          <stop offset="1" stopColor="#20120a" />
        </linearGradient>
        <radialGradient id="ht-flame" cx="0.5" cy="0.75" r="0.75">
          <stop offset="0" stopColor="#fff3cf" />
          <stop offset="0.45" stopColor="#f6c66a" />
          <stop offset="1" stopColor="#d97b2a" stopOpacity="0.9" />
        </radialGradient>
        <radialGradient id="ht-vignette" cx="0.45" cy="0.55" r="0.85">
          <stop offset="0" stopColor="#120a05" stopOpacity="0" />
          <stop offset="0.72" stopColor="#120a05" stopOpacity="0" />
          <stop offset="1" stopColor="#0c0603" stopOpacity="0.9" />
        </radialGradient>
        <filter id="ht-soft" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="16" />
        </filter>
        <filter id="ht-softer" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="34" />
        </filter>
        <pattern
          id="ht-lattice"
          width="46"
          height="46"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M23 3 43 23 23 43 3 23Z M23 13 33 23 23 33 13 23Z"
            fill="none"
            stroke="#c2913f"
            strokeOpacity="0.1"
          />
        </pattern>
      </defs>

      {/* Room */}
      <rect width="720" height="880" fill="url(#ht-room)" />
      <rect width="720" height="880" fill="url(#ht-lattice)" />

      {/* Arched alcove */}
      <path
        d="M96 880 V400 Q96 176 320 176 Q544 176 544 400 V880 Z"
        fill="#241811"
      />
      <path
        d="M96 880 V400 Q96 176 320 176 Q544 176 544 400 V880 Z"
        fill="url(#ht-arch-glow)"
      />
      <path
        d="M96 880 V400 Q96 176 320 176 Q544 176 544 400 V880"
        fill="none"
        stroke="#c2913f"
        strokeOpacity="0.35"
        strokeWidth="3"
      />
      <path
        d="M120 880 V404 Q120 200 320 200 Q520 200 520 404 V880"
        fill="none"
        stroke="#c2913f"
        strokeOpacity="0.14"
        strokeWidth="1.5"
      />

      {/* Ambient candle glow */}
      <ellipse cx="292" cy="648" rx="330" ry="300" fill="url(#ht-glow)" />

      {/* Shelf with vessels (material culture, abstracted) */}
      <rect x="558" y="392" width="130" height="8" rx="3" fill="#2c1c10" />
      <path
        d="M586 392 v-38 q0 -14 12 -14 q12 0 12 14 v38 Z"
        fill="#3a2a1d"
        stroke="#c2913f"
        strokeOpacity="0.3"
      />
      <path
        d="M626 392 v-24 q0 -20 16 -20 q16 0 16 20 v24 Z"
        fill="#33220f"
        stroke="#c2913f"
        strokeOpacity="0.24"
      />
      <rect x="558" y="524" width="130" height="8" rx="3" fill="#2c1c10" />
      <ellipse cx="606" cy="504" rx="22" ry="18" fill="#3a2a1d" />
      <ellipse cx="606" cy="492" rx="14" ry="6" fill="url(#ht-brass)" opacity="0.75" />
      <path
        d="M648 524 v-30 l10 -12 h6 l10 12 v30 Z"
        fill="#33220f"
        stroke="#c2913f"
        strokeOpacity="0.22"
      />

      {/* Seated figure — dignified, stylized, facing the candles */}
      <g>
        {/* flowing robe */}
        <path
          d="M212 880
             C204 776 224 668 268 596
             C286 566 300 540 306 512
             L360 500
             C400 540 428 596 446 660
             C466 730 474 806 476 880 Z"
          fill="url(#ht-robe)"
        />
        <path
          d="M212 880 C204 776 224 668 268 596 C286 566 300 540 306 512 L360 500 C400 540 428 596 446 660 C466 730 474 806 476 880 Z"
          fill="url(#ht-robe-shade)"
        />
        {/* fold lines */}
        <path
          d="M300 560 C296 640 288 730 292 880 M340 540 C356 620 368 720 372 880 M400 590 C416 668 428 760 432 880"
          fill="none"
          stroke="#a98e5f"
          strokeOpacity="0.45"
          strokeWidth="2.5"
        />
        {/* sleeve reaching toward the low table */}
        <path
          d="M306 560 C270 592 240 626 224 664 C216 684 228 700 250 694 C286 684 316 660 336 630 Z"
          fill="#e7dcc2"
        />
        {/* neck + head, profile */}
        <path
          d="M318 508 q-4 -26 8 -34 q0 -18 10 -26 q16 -12 32 -2 q10 8 10 24 q0 10 -6 18 q10 10 6 22 q-24 12 -60 -2 Z"
          fill="url(#ht-skin)"
        />
        {/* fila cap */}
        <path
          d="M330 448 q4 -22 26 -24 q22 -2 28 16 q2 8 -2 12 q-30 -10 -52 -4 Z"
          fill="#8c3a30"
        />
        <path
          d="M382 440 q14 2 12 16 l-10 4 q2 -12 -2 -20 Z"
          fill="#7a2f27"
        />
        {/* coral bead strands */}
        <path
          d="M334 520 q22 18 46 12"
          fill="none"
          stroke="#a4392f"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray="0.1 11"
        />
        <path
          d="M330 534 q26 22 54 14"
          fill="none"
          stroke="#c04a37"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray="0.1 10"
        />
      </g>

      {/* Low table with brass vessels and candles */}
      <g>
        <path d="M104 704 H420 l-14 44 H120 Z" fill="url(#ht-wood)" />
        <rect x="128" y="748" width="14" height="132" fill="#20120a" />
        <rect x="382" y="748" width="14" height="132" fill="#1a0e07" />

        {/* brass bowl */}
        <ellipse cx="200" cy="700" rx="44" ry="12" fill="#6d4a1a" />
        <path d="M156 700 q6 30 44 30 q38 0 44 -30 Z" fill="url(#ht-brass)" />
        <ellipse cx="200" cy="700" rx="34" ry="8" fill="#2a1a0c" />
        {/* calabash */}
        <ellipse cx="266" cy="688" rx="24" ry="20" fill="#3a2413" />
        <ellipse cx="266" cy="680" rx="20" ry="9" fill="#553517" />

        {/* candles */}
        <g>
          <ellipse
            cx="336"
            cy="620"
            rx="120"
            ry="110"
            fill="#f0b95c"
            opacity="0.16"
            filter="url(#ht-softer)"
          />
          <rect x="312" y="612" width="26" height="92" rx="5" fill="#efe3c6" />
          <rect x="348" y="640" width="22" height="64" rx="5" fill="#e6d7b2" />
          <rect x="378" y="660" width="18" height="44" rx="4" fill="#efe3c6" />
          <ellipse
            cx="325"
            cy="596"
            rx="20"
            ry="26"
            fill="#f6c66a"
            opacity="0.5"
            filter="url(#ht-soft)"
          />
          <path d="M325 574 q10 14 0 30 q-10 -16 0 -30 Z" fill="url(#ht-flame)" />
          <ellipse
            cx="359"
            cy="626"
            rx="16"
            ry="20"
            fill="#f6c66a"
            opacity="0.5"
            filter="url(#ht-soft)"
          />
          <path d="M359 608 q8 12 0 24 q-8 -13 0 -24 Z" fill="url(#ht-flame)" />
          <ellipse
            cx="387"
            cy="648"
            rx="13"
            ry="16"
            fill="#f6c66a"
            opacity="0.45"
            filter="url(#ht-soft)"
          />
          <path d="M387 634 q7 10 0 20 q-7 -11 0 -20 Z" fill="url(#ht-flame)" />
        </g>
      </g>

      {/* Floor light pool + vignette */}
      <ellipse cx="300" cy="856" rx="330" ry="70" fill="#c2913f" opacity="0.1" />
      <rect width="720" height="880" fill="url(#ht-vignette)" />
    </svg>
  )
}
