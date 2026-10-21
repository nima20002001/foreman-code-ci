import { describe, it } from 'vitest'
import { checksProfilesAcrossInstallationUpdate } from './helpers/harnessInstallationUpdateProfiles.js'

describe('installed harness updates', () => {
  it('automatically checks every qualified worker profile and preserves the running process through authenticated MCP',
    () => checksProfilesAcrossInstallationUpdate('worker'), 240_000)
})
