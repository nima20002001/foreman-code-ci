import { createHash } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JobVerificationProfileInputSchema } from '@foreman-code/contracts/job-verification-runtime'
import { captureInstalledVerificationRuntimeConfiguration } from '../src/modules/jobs/installedVerificationRuntime.js'
import { InstalledVerificationRuntimeCaptureInputSchema, MAX_VERIFICATION_CONFIGURATION_BYTES }
  from '../src/modules/jobs/installedVerificationConfiguration.js'
import { createInstalledJobRuntimeHost, readProtectedRuntimeConfiguration, readProtectedRuntimeFile }
  from '../src/modules/jobs/installedRuntimeHost.js'
import { createVerificationProfile } from '../src/modules/jobs/verificationProfiles.js'
import { bootIdentity } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'

describe('installed verification metadata capture on an enforced project-quota volume', () => {
  it('captures binaries, seed and approved source and restores the same fingerprint after restart', async () => {
    const inputPath = process.env.FOREMAN_CODE_VERIFICATION_QUALIFICATION_CAPTURE_INPUT
    const profilePath = process.env.FOREMAN_CODE_VERIFICATION_QUALIFICATION_PROFILE
    if (!inputPath || !profilePath) throw new Error('Provide protected verification capture-input and profile paths.')
    const ownerUid = process.getuid!()
    const input = await readProtectedRuntimeConfiguration({ path: inputPath, ownerUid },
      InstalledVerificationRuntimeCaptureInputSchema, MAX_VERIFICATION_CONFIGURATION_BYTES)
    const spec = await readProtectedRuntimeConfiguration({ path: profilePath, ownerUid }, JobVerificationProfileInputSchema)
    const directory = await privateFixtureDirectory('verification-capture-')
    const db = await currentDatabase()
    try {
      const originalSeed = await readProtectedRuntimeFile({ path: input.seedReceiptPath, ownerUid }, 16 * 1024 * 1024)
      const seedReceiptPath = join(directory, 'seed-receipt.json')
      await writeFile(seedReceiptPath, originalSeed, { mode: 0o600 })
      const configuration = await captureInstalledVerificationRuntimeConfiguration({ ...input, seedReceiptPath })
      expect(configuration.machine.tools.some(tool => tool.kind === 'codex')).toBe(true)
      expect(input.descriptor.target.hostRef.kind).toBe('main')
      const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
      expect(configuration.machine.runtimeBinarySha256).toBe(digest(await readFile(input.descriptor.runtimeExecutable)))
      for (const tool of input.toolSources) {
        expect(configuration.machine.tools.find(value => value.kind === tool.kind)?.binarySha256)
          .toBe(digest(await readFile(tool.sourceExecutable)))
      }
      expect(configuration.machine.bootId).toBe(bootIdentity())
      expect(configuration.seedReceiptSha256).toBe(digest(originalSeed))
      expect(configuration.qualificationSource).toEqual(input.qualificationSource)
      expect('measurement' in configuration).toBe(false)
      expect(Buffer.byteLength(JSON.stringify(configuration))).toBeGreaterThan(65536)
      const configurationPath = join(directory, 'job-runtime.json')
      await writeFile(configurationPath, JSON.stringify(configuration), { mode: 0o600 })
      await db.pool.query('update application_installation set id=$1 where singleton=true',
        [input.descriptor.target.mainInstallationId])
      const profile = createVerificationProfile({ id: 'verification-capture', revision: 1,
        workspaceId: input.root.binding.workspaceId, name: 'Installed verification capture', root: input.root,
        sourceCommit: input.qualificationSource.manifest.git!.commit, spec,
        previous: null, now: new Date().toISOString() })
      const hostInput = { identity: db.pool, configuration: { path: configurationPath, ownerUid },
        reserve: async () => { throw new Error('Metadata capture cannot reserve native work.') } }
      const host = createInstalledJobRuntimeHost(hostInput)
      expect(await host.currentMetadata(db.pool, profile)).toBeNull()
      const fingerprint = await host.capture!(profile)
      expect(fingerprint).toMatchObject({ schemaVersion: 3, sourceCommit: profile.sourceCommit, profileId: profile.id })
      const restarted = createInstalledJobRuntimeHost(hostInput)
      expect(await restarted.currentMetadata(db.pool, profile)).toBeNull()
      expect(await restarted.capture!(profile)).toEqual(fingerprint)
      expect(await restarted.currentMetadata(db.pool, profile)).toEqual(fingerprint)
      await writeFile(seedReceiptPath, 'changed seed')
      await expect(restarted.capture!(profile)).rejects.toThrow('seed receipt changed')
    } finally {
      await db.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
