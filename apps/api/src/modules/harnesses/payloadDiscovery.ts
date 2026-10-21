import { logIgnoredError } from '../diagnostics/ignoredError.js'
import { access, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { inventoryPayloadFingerprints, type PayloadFingerprintCache } from './payloadFingerprintCache.js'

// @openai/codex 0.154.0 bin/codex.js; only this measured launcher algorithm is supported.
const codexNpmLauncher = { bytes: 8790, sha256: '61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70' }

/** Resolve only a directly executable image or the repository's pinned Codex
 * npm launcher algorithm. Arbitrary scripts are visible but not payload-trusted. */
export async function passiveDriverPayloads(driver: string, launcher: string,
  platform: string = process.platform, architecture: string = process.arch, fingerprintCache?: PayloadFingerprintCache): Promise<{ complete: boolean; paths: string[] }> {
  const file = await open(launcher, 'r')
  const prefix = Buffer.alloc(4)
  try {
    await file.read(prefix, 0, prefix.length, 0)
    const image = prefix.toString('hex')
    if (image === '7f454c46' || image.startsWith('4d5a')
      || ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(image)) return { complete: true, paths: [] }
    if (driver !== 'codex' || (await file.stat()).size !== codexNpmLauncher.bytes) return { complete: false, paths: [] }
    const digest = fingerprintCache
      ? await fingerprintCache.fingerprint(launcher)
      : createHash('sha256').update(await file.readFile()).digest('hex')
    if (digest !== codexNpmLauncher.sha256) return { complete: false, paths: [] }
  } finally {
    await file.close()
  }
  const selected = await realpath(launcher)
  const targets: Record<string, { package: string; triple: string }> = {
    'linux:x64': { package: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
    'linux:arm64': { package: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
    'darwin:x64': { package: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
    'darwin:arm64': { package: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
    'win32:x64': { package: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
    'win32:arm64': { package: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
  }
  const target = targets[`${platform === 'android' ? 'linux' : platform}:${architecture}`]
  if (!target) return { complete: false, paths: [] }
  const requireLauncher = createRequire(selected)
  let vendor: string
  try { vendor = join(dirname(requireLauncher.resolve(`${target.package}/package.json`)), 'vendor') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
    logIgnoredError('harness', 'select native payload layout', error)
    vendor = join(dirname(selected), '..', 'vendor')
  }
  const payload = join(vendor, target.triple, 'bin', platform === 'win32' ? 'codex.exe' : 'codex')
  try { await access(payload, constants.X_OK); return { complete: true, paths: [await realpath(payload)] } }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    logIgnoredError('harness', 'inspect native package payload', error)
    return { complete: false, paths: [] }
  }
}

export const inventoryDriverPayloads: typeof passiveDriverPayloads = (driver, launcher, platform, architecture) =>
  passiveDriverPayloads(driver, launcher, platform, architecture, inventoryPayloadFingerprints)
