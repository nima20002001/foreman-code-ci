import { describe, it } from 'vitest'
import { retainsRunAcrossUnavailableInstallation } from './helpers/harnessInstallationUnavailable.js'

describe('installed harness updates', () => {
  it('retains a resident main Run across unavailable inventory before a completed payload replacement',
    () => retainsRunAcrossUnavailableInstallation('main'), 240_000)
})
