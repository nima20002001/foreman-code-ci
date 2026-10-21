import { statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { JobVerificationQuotaPoolSchema } from '@foreman-code/contracts/job-verification-runtime'
import { readProtectedRuntimeConfiguration } from '../src/modules/jobs/installedRuntimeHost.js'
import { readJobProjectQuota } from '../src/modules/jobs/quotaOwnership.js'

const configurationSchema = z.object({
  volume: z.string().startsWith('/'),
  sourceParent: z.string().startsWith('/'),
  pool: JobVerificationQuotaPoolSchema,
}).strict()

it('reads whole-volume capacity separately from each enforced Job quota', async () => {
  const path = process.env.FOREMAN_CODE_VERIFICATION_QUOTA_CONFIGURATION
  if (!path) throw new Error('Provide the installed verification quota configuration.')
  const configuration = await readProtectedRuntimeConfiguration(
    { path, ownerUid: process.getuid!() }, configurationSchema,
  )
  const filesystem = await statfs(configuration.volume, { bigint: true })
  const volumeBytes = Number(filesystem.blocks * filesystem.bsize)
  const volumeInodes = Number(filesystem.files)
  const reservedBytes = configuration.pool.slots.reduce((sum, slot) => sum + slot.hardLimitBytes, 0)
  const reservedInodes = configuration.pool.slots.reduce((sum, slot) => sum + slot.hardInodes, 0)
  expect(volumeBytes).toBeGreaterThan(reservedBytes)
  expect(volumeInodes).toBeGreaterThan(reservedInodes)
  for (const slot of configuration.pool.slots) {
    const observed = await readJobProjectQuota(configuration.pool,
      join(configuration.sourceParent, slot.namespace), AbortSignal.timeout(10_000))
    expect(observed).toMatchObject({
      projectId: slot.projectId,
      hardLimitBytes: slot.hardLimitBytes,
      hardInodes: slot.hardInodes,
      volumeCapacityBytes: volumeBytes,
      volumeCapacityInodes: volumeInodes,
      inheritance: true,
      accountingEnabled: true,
    })
  }
})
