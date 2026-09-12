import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'bun:test'

import {
  HOUSE_VISUALS,
  getHouseVisualsByName,
  getHouseVisualsBySlug,
} from '@/lib/governed-house-visuals'

const read = (relativePath: string): string =>
  readFileSync(join(process.cwd(), relativePath), 'utf8')

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function publicFile(src: string): string {
  expect(src.startsWith('/assets/governed-house-visuals/')).toBe(true)
  expect(src).not.toContain('..')
  return join(process.cwd(), 'public', ...src.slice(1).split('/'))
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function pngDimensions(path: string): { width: number; height: number } {
  const buffer = readFileSync(path)
  expect(buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

function listFiles(root: string): Array<string> {
  const absoluteRoot = join(process.cwd(), root)
  if (!existsSync(absoluteRoot)) return []
  const found: Array<string> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else found.push(relative(process.cwd(), full).replaceAll('\\', '/'))
    }
  }
  walk(absoluteRoot)
  return found.sort()
}

describe('governed Sacred House visuals', () => {
  it('binds all four launch Houses by public catalogue identity', () => {
    expect(HOUSE_VISUALS.map((visuals) => visuals.code).sort()).toEqual([
      'ABULE_AJE',
      'ABULE_OSANYIN_AJA',
      'ABULE_OSUN',
      'ILE_AWON_BABALAWO',
    ])

    for (const visuals of HOUSE_VISUALS) {
      expect(getHouseVisualsBySlug(visuals.slug)).toBe(visuals)
      expect(getHouseVisualsByName(visuals.name)).toBe(visuals)
      expect(visuals.spiritualSetting.surfaceClassName).toMatch(/^bg-\[/)
      expect(visuals.spiritualSetting.overlayClassName).toContain(
        'linear-gradient',
      )
    }
  })

  it('gives each launch House a distinct spiritual setting treatment', () => {
    expect(
      new Set(
        HOUSE_VISUALS.map(
          (visuals) => visuals.spiritualSetting.overlayClassName,
        ),
      ).size,
    ).toBe(HOUSE_VISUALS.length)
  })

  it('uses the exact approved image bytes and dimensions', () => {
    for (const visuals of HOUSE_VISUALS) {
      for (const asset of [
        visuals.environment,
        visuals.profile,
        visuals.prayerPoster,
      ].filter((value): value is NonNullable<typeof value> => value != null)) {
        const path = publicFile(asset.src)
        expect(existsSync(path)).toBe(true)
        expect(sha256(path)).toBe(asset.sha256)
        expect(pngDimensions(path)).toEqual({
          width: asset.width,
          height: asset.height,
        })
      }
    }
  })

  it('assigns the requested Babalawo files to their requested roles', () => {
    const visuals = getHouseVisualsBySlug('ile-awon-babalawo')
    expect(visuals).toBeTruthy()
    expect(visuals!.environment.src).toContain('06_ENVIRONMENT_INSERT.png')
    expect(visuals!.profile.src).toContain('03_DIRECT_CAMERA.png')
    expect(visuals!.prayerPoster?.src).toContain('02_MEDIUM_PRAYER.png')
    expect(visuals!.environment.sha256).toBe(
      '8e9d7a9bea9693f4562f5415a9b3aeb5b7664853d2b34d9750d99b79f4b3fff7',
    )
    expect(visuals!.profile.sha256).toBe(
      '7bc970edba3008e6e8d9947aa57c08e859bd68b1decd8f37e3b7b289a5a1ac08',
    )
    expect(visuals!.prayerPoster?.sha256).toBe(
      '43b57a7248448449515a5e268cf7bd7465ed420ac587f2ddf62861990afcae85',
    )
  })

  it('keeps the Babalawo MP4 out of the public web root', () => {
    const publicFiles = listFiles('public')
    expect(
      publicFiles.some((file) =>
        file.includes('BABALAWO_PRAYER_ROOM_90S_MASTER_V2.mp4'),
      ),
    ).toBe(false)
  })

  it('wires public and Prayer Room surfaces to governed visual bindings', () => {
    const directory = withoutComments(
      read('src/routes/sacred-houses.index.tsx'),
    )
    expect(directory).toContain('getHouseVisualsBySlug')
    expect(directory).toContain('visuals.environment.src')

    const detail = withoutComments(read('src/routes/sacred-houses.$slug.tsx'))
    expect(detail).toContain('HouseVisualBanner')
    expect(detail).toContain('BabalawoProfilePanel')
    expect(detail).toContain('visuals.spiritualSetting')
    expect(detail).toContain('visuals.profile.src')
    expect(detail).not.toMatch(/testimonial|review|rating/i)

    const prayerRoom = withoutComments(
      read('src/routes/prayer-room.$publicId.tsx'),
    )
    expect(prayerRoom).toContain('getHouseVisualsByName(status.houseName)')
    expect(prayerRoom).toContain('poster={poster}')
    expect(prayerRoom).toContain('/api/prayer-room/')
    expect(prayerRoom).not.toContain('BABALAWO_PRAYER_ROOM_90S_MASTER_V2.mp4')
    expect(prayerRoom).not.toContain('storageKey')
  })

  it('documents the watermarked proof as a private governed baseline', () => {
    const script = read('scripts/import-babalawo-production-proof.ts')
    expect(script).toContain('PRODUCTION_PROOF / MASTER_BASELINE')
    expect(script).toContain('visible KlingAI watermark')
    expect(script).toContain('createMediaVersion')
    expect(script).toContain('getMediaStorage')
    expect(script).not.toContain(
      'setMediaRuntimeEnabled(actorId, ctx, versionId, true)',
    )
  })
})
