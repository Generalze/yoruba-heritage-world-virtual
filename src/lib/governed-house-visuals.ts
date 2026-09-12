export interface GovernedImageAsset {
  src: string
  width: number
  height: number
  sha256: string
  sourcePackagePath: string
}

export interface GovernedHouseVisuals {
  id: number
  code: string
  name: string
  slug: string
  spiritualSetting: {
    surfaceClassName: string
    overlayClassName: string
    accentClassName: string
    motifClassName: string
  }
  environment: GovernedImageAsset
  profile: GovernedImageAsset
  prayerPoster?: GovernedImageAsset
}

const ROOT = '/assets/governed-house-visuals'
const MASTER_SOURCE =
  'YHW_MASTER_VISUAL_IMPLEMENTATION_V2_24_IMAGES/YHW_MASTER_VISUAL_IMPLEMENTATION_V2'

export const HOUSE_VISUALS: ReadonlyArray<GovernedHouseVisuals> = [
  {
    id: 1,
    code: 'ABULE_OSUN',
    name: 'Abúlé Ọ̀ṣun',
    slug: 'abule-osun',
    spiritualSetting: {
      surfaceClassName: 'bg-[#071b18]',
      overlayClassName:
        'bg-[radial-gradient(circle_at_20%_18%,rgba(44,153,132,0.34),transparent_34%),linear-gradient(105deg,rgba(4,18,20,0.94),rgba(15,62,55,0.78)_52%,rgba(153,116,38,0.42))]',
      accentClassName: 'bg-[#d8b158]',
      motifClassName: 'border-[#d8b158]/45 bg-[#0d302a]/65',
    },
    environment: {
      src: `${ROOT}/02_ABULE_OSUN/06_ENVIRONMENT_INSERT.png`,
      width: 1672,
      height: 941,
      sha256:
        '7160fc6b00069849f6b9abdbc0a5b9991b54fb83642c4c49a2aa885a5f3fb5fb',
      sourcePackagePath: `${MASTER_SOURCE}/02_ABULE_OSUN/06_ENVIRONMENT_INSERT.png`,
    },
    profile: {
      src: `${ROOT}/02_ABULE_OSUN/03_DIRECT_CAMERA.png`,
      width: 1672,
      height: 941,
      sha256:
        'a57b4fa2832762f76ae4bee739cade365ca132532c3626e996440495306b5173',
      sourcePackagePath: `${MASTER_SOURCE}/02_ABULE_OSUN/03_DIRECT_CAMERA.png`,
    },
  },
  {
    id: 2,
    code: 'ABULE_AJE',
    name: 'Abúlé Ajé Ṣalúgà / Ajé Olókun',
    slug: 'abule-aje',
    spiritualSetting: {
      surfaceClassName: 'bg-[#111827]',
      overlayClassName:
        'bg-[radial-gradient(circle_at_76%_22%,rgba(222,180,80,0.28),transparent_30%),linear-gradient(112deg,rgba(8,12,28,0.96),rgba(30,44,74,0.78)_48%,rgba(75,52,21,0.5))]',
      accentClassName: 'bg-[#e1bd69]',
      motifClassName: 'border-[#e1bd69]/45 bg-[#18233d]/65',
    },
    environment: {
      src: `${ROOT}/03_ABULE_AJE/06_ENVIRONMENT_INSERT.png`,
      width: 1672,
      height: 941,
      sha256:
        '3c9db1cf8cded7549adbd189afdcce26120cf1b68398d1827a0b6f43e4196693',
      sourcePackagePath: `${MASTER_SOURCE}/03_ABULE_AJE/06_ENVIRONMENT_INSERT.png`,
    },
    profile: {
      src: `${ROOT}/03_ABULE_AJE/03_DIRECT_CAMERA.png`,
      width: 1672,
      height: 941,
      sha256:
        '73d34856d3e61104b113c3b7c6dd9c9e877a245eb43bf161774e33aed61affa6',
      sourcePackagePath: `${MASTER_SOURCE}/03_ABULE_AJE/03_DIRECT_CAMERA.png`,
    },
  },
  {
    id: 3,
    code: 'ABULE_OSANYIN_AJA',
    name: 'Abúlé Ọ̀sanyìn àti Àjà',
    slug: 'abule-osanyin-aja',
    spiritualSetting: {
      surfaceClassName: 'bg-[#111a12]',
      overlayClassName:
        'bg-[radial-gradient(circle_at_30%_22%,rgba(97,128,68,0.34),transparent_32%),linear-gradient(110deg,rgba(11,21,13,0.95),rgba(38,61,36,0.8)_54%,rgba(93,72,38,0.45))]',
      accentClassName: 'bg-[#b5c46c]',
      motifClassName: 'border-[#b5c46c]/45 bg-[#1d321f]/65',
    },
    environment: {
      src: `${ROOT}/04_ABULE_OSANYIN_AJA/06_ENVIRONMENT_INSERT.png`,
      width: 1672,
      height: 941,
      sha256:
        '37a45d5f38771cc21ad5c2da59b8ce039cfabe0e512e24423e701f6a8e81b57e',
      sourcePackagePath: `${MASTER_SOURCE}/04_ABULE_OSANYIN_AJA/06_ENVIRONMENT_INSERT.png`,
    },
    profile: {
      src: `${ROOT}/04_ABULE_OSANYIN_AJA/03_DIRECT_CAMERA.png`,
      width: 1672,
      height: 941,
      sha256:
        'd0027b14020b032c1aa5e636f27ddf7c418e1411234130f57232fc1cfbedb15d',
      sourcePackagePath: `${MASTER_SOURCE}/04_ABULE_OSANYIN_AJA/03_DIRECT_CAMERA.png`,
    },
  },
  {
    id: 4,
    code: 'ILE_AWON_BABALAWO',
    name: 'Ilé Àwọn Babaláwo',
    slug: 'ile-awon-babalawo',
    spiritualSetting: {
      surfaceClassName: 'bg-[#17110d]',
      overlayClassName:
        'bg-[radial-gradient(circle_at_72%_18%,rgba(194,143,49,0.3),transparent_30%),linear-gradient(108deg,rgba(16,10,7,0.96),rgba(45,29,18,0.84)_50%,rgba(96,62,25,0.5))]',
      accentClassName: 'bg-[#c8942f]',
      motifClassName: 'border-[#c8942f]/45 bg-[#2d1d12]/68',
    },
    environment: {
      src: `${ROOT}/01_ILE_AWON_BABALAWO/06_ENVIRONMENT_INSERT.png`,
      width: 1536,
      height: 1024,
      sha256:
        '8e9d7a9bea9693f4562f5415a9b3aeb5b7664853d2b34d9750d99b79f4b3fff7',
      sourcePackagePath: `${MASTER_SOURCE}/01_ILE_AWON_BABALAWO/06_ENVIRONMENT_INSERT.png`,
    },
    profile: {
      src: `${ROOT}/01_ILE_AWON_BABALAWO/03_DIRECT_CAMERA.png`,
      width: 1672,
      height: 941,
      sha256:
        '7bc970edba3008e6e8d9947aa57c08e859bd68b1decd8f37e3b7b289a5a1ac08',
      sourcePackagePath: `${MASTER_SOURCE}/01_ILE_AWON_BABALAWO/03_DIRECT_CAMERA.png`,
    },
    prayerPoster: {
      src: `${ROOT}/01_ILE_AWON_BABALAWO/02_MEDIUM_PRAYER.png`,
      width: 1672,
      height: 941,
      sha256:
        '43b57a7248448449515a5e268cf7bd7465ed420ac587f2ddf62861990afcae85',
      sourcePackagePath: `${MASTER_SOURCE}/01_ILE_AWON_BABALAWO/02_MEDIUM_PRAYER.png`,
    },
  },
] as const

export const HOUSE_VISUALS_BY_SLUG = Object.fromEntries(
  HOUSE_VISUALS.map((visuals) => [visuals.slug, visuals]),
) as Record<string, GovernedHouseVisuals | undefined>

export const HOUSE_VISUALS_BY_ID = Object.fromEntries(
  HOUSE_VISUALS.map((visuals) => [visuals.id, visuals]),
) as Record<number, GovernedHouseVisuals | undefined>

export const HOUSE_VISUALS_BY_NAME = Object.fromEntries(
  HOUSE_VISUALS.map((visuals) => [visuals.name, visuals]),
) as Record<string, GovernedHouseVisuals | undefined>

export function getHouseVisualsBySlug(
  slug: string,
): GovernedHouseVisuals | undefined {
  return HOUSE_VISUALS_BY_SLUG[slug]
}

export function getHouseVisualsById(
  id: number,
): GovernedHouseVisuals | undefined {
  return HOUSE_VISUALS_BY_ID[id]
}

export function getHouseVisualsByName(
  name: string,
): GovernedHouseVisuals | undefined {
  return HOUSE_VISUALS_BY_NAME[name]
}
