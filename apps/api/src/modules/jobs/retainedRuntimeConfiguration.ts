import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { z } from 'zod'
import { DomainError } from '../errors.js'
import { readProtectedRuntimeConfiguration, readProtectedRuntimeFile,
  type InstalledRuntimeConfigurationLocation } from './installedRuntimeConfiguration.js'

/** Refresh retains protected configurations so accepted jobs can still use their original image and source. */
export async function findRetainedRuntimeConfiguration<T>(
  location: InstalledRuntimeConfigurationLocation | null,
  schema: z.ZodType<T>,
  matches: (configuration: T) => boolean,
  maximumBytes: number,
): Promise<T | null> {
  const current = await readProtectedRuntimeConfiguration(location, schema, maximumBytes)
  if (matches(current)) return current
  if (!location) return null
  const directory = dirname(location.path)
  const names = (await readdir(directory)).filter(name => /^job-runtime-[a-f0-9]{64}\.json$/u.test(name)).sort()
  for (const name of names) {
    const path = join(directory, name)
    const bytes = await readProtectedRuntimeFile({ ...location, path }, maximumBytes).catch(async (error: unknown) => {
      // Runtime preparation retires configurations nothing uses any more.
      if (await lstat(path).then(() => true, (missing: NodeJS.ErrnoException) => missing.code !== 'ENOENT')) throw error
      return null
    })
    if (!bytes) continue
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (name !== `job-runtime-${digest}.json`) {
      throw new DomainError('JOB_RUNTIME_CONTEXT_CHANGED', 'A retained runtime configuration changed.', 409)
    }
    const parsed = schema.safeParse(JSON.parse(bytes.toString('utf8')))
    if (parsed.success && matches(parsed.data)) return parsed.data
  }
  return null
}
