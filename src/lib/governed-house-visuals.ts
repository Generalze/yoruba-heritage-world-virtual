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
