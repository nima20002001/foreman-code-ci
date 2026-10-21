import { describe, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { recoverTerminalBeforeClosure, useCrashCutDatabase } from './helpers/restartCrashCuts.js'

describe.skipIf(!postgresEnabled)('terminal recovery before native closure', () => {
  const database = useCrashCutDatabase()
  describe.each(['sequential', 'repeat'] as const)('%s', (form) => {
    it('recovers a durable terminal before its closure receipt: retry-exhausted', async () => {
      await recoverTerminalBeforeClosure(database(), form, 'retry-exhausted')
    }, 60_000)
  })
})
