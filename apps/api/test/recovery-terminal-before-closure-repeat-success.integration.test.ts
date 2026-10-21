import { describe, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { recoverTerminalBeforeClosure, useCrashCutDatabase } from './helpers/restartCrashCuts.js'

/** PostgreSQL, source captures, checkpoint, approval ACK and acceptance services
 * are real. Only provider transport and filesystem qualification are synthetic. */
describe.skipIf(!postgresEnabled)('terminal recovery before native closure', () => {
  const database = useCrashCutDatabase()
  describe.each(['repeat'] as const)('%s', (form) => {
    it('recovers a durable terminal before its closure receipt: success', async () => {
      await recoverTerminalBeforeClosure(database(), form, 'success')
    }, 60_000)
  })
})
