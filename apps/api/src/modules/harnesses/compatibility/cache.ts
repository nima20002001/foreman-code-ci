import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { HarnessCompatibilityReasonSchema, type CompatibilityHarness } from '@foreman-code/contracts'

export const CompatibilityCacheEntrySchema = z.object({
  format: z.literal(2), key: z.string().regex(/^[a-f0-9]{64}$/),
  harness: z.literal('codex'),
  installedVersion: z.string().min(1).max(100),
  checkedAt: z.string().datetime(), expiresAt: z.string().datetime(),
  status: z.enum(['probe-passed', 'probe-failed']),
  reason: HarnessCompatibilityReasonSchema.nullable(),
  schemaSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict()
export type CompatibilityCacheEntry = z.infer<typeof CompatibilityCacheEntrySchema>
export interface CompatibilityCache {
  load(harness: CompatibilityHarness, key: string, now: number): Promise<CompatibilityCacheEntry | null>
  save(entry: CompatibilityCacheEntry): Promise<void>
}
export function compatibilityCacheDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.XDG_CACHE_HOME
  return join(configured && isAbsolute(configured) ? configured : join(homedir(), '.cache'), 'graphql', 'harness-compatibility-v2')
}

/** One bounded, atomically replaced record per provider. No DB or network dependency. */
export class FileCompatibilityCache implements CompatibilityCache {
  constructor(private readonly directory = compatibilityCacheDirectory()) {}
  async load(harness: CompatibilityHarness, key: string, now: number): Promise<CompatibilityCacheEntry | null> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const directory = await lstat(this.directory)
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Unsafe cache directory.')
      handle = await open(join(this.directory, `${harness}.json`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const info = await handle.stat()
      if (!info.isFile() || info.size > 16_384) throw new Error('Invalid cache file.')
      // Read at most the cap even if the file is replaced/grows after stat.
      const bytes = Buffer.alloc(16_385)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 16_384) throw new Error('Invalid cache size.')
      const parsed = CompatibilityCacheEntrySchema.parse(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')))
      const checked = Date.parse(parsed.checkedAt)
      const expires = Date.parse(parsed.expiresAt)
      const maxAge = parsed.status === 'probe-passed' ? 7 * 86_400_000 : 60_000
      if (parsed.key !== key || parsed.harness !== harness || checked > now || expires <= now
        || expires <= checked || expires - checked > maxAge) return null
      if ((parsed.status === 'probe-passed') !== (parsed.reason === null) || (parsed.status === 'probe-passed' && !parsed.schemaSha256)) return null
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error // The service recomputes, and reports a cache warning without failing startup.
    } finally { await handle?.close() }
  }
  async save(value: CompatibilityCacheEntry): Promise<void> {
    const entry = CompatibilityCacheEntrySchema.parse(value)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe cache directory.')
    const temporary = join(this.directory, `.${entry.harness}-${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(JSON.stringify(entry) + '\n')
      await handle.sync()
      await handle.close(); handle = undefined
      await rename(temporary, join(this.directory, `${entry.harness}.json`))
    } finally { await handle?.close(); await rm(temporary, { force: true }) }
  }
}
