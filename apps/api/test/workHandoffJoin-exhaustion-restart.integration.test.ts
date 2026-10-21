import { describe, it } from 'vitest'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { releasesRevisedJoinAfterExhaustion } from './helpers/workHandoffJoinExhaustion.js'

describe.skipIf(!postgresEnabled)('work join routing and rounds', () => {
  it('releases a revised join after an incoming connection is exhausted and its notice finishes (restart=true)', async () => {
    await releasesRevisedJoinAfterExhaustion({ restart: true })
  }, 120000)
})
