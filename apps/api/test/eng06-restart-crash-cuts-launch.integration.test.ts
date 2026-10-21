import { describe, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { recoverEnteredLaunch, useCrashCutDatabase } from './helpers/restartCrashCuts.js'

/** PostgreSQL, owner transactions, checkpoint and acceptance services are real.
 * Only the external provider and filesystem qualification are synthetic. */
describe.skipIf(!postgresEnabled)('ENG06 exact restart crash cuts, semantics 3', () => {
  const database = useCrashCutDatabase()
  describe.each(['sequential', 'repeat'] as const)('%s', (form) => {
    it.skipIf(process.platform !== 'linux').each(['stop', 'reconcile'] as const)(
      'settles %s after entered COMMIT but before the first process dispatch', async (finish) => {
        await recoverEnteredLaunch(database(), form, finish)
      }, 60_000)
  })
})
