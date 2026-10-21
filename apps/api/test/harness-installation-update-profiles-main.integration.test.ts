import { describe, it } from 'vitest'
import { checksProfilesAcrossInstallationUpdate } from './helpers/harnessInstallationUpdateProfiles.js'

describe('installed harness updates', () => {
  it('automatically checks every qualified main profile and preserves the running process through authenticated MCP',
    () => checksProfilesAcrossInstallationUpdate('main'), 240_000)
})
