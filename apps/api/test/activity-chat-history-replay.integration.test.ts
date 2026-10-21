import { afterEach, describe, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { closeActivityReplay } from './helpers/activityReplayFixture.js'
import { replayChatHistory } from './helpers/activityReplayChatHistory.js'

afterEach(closeActivityReplay)

describe.skipIf(!postgresEnabled)('chat activity history replay', { timeout: 120000 }, () => {
  for (const selected of [false, true]) it(`${selected ? 'selected Run' : 'Agent'}: older active/newer queued, final empty, replay and restart preserve exact source`,
    () => replayChatHistory({ selectedRun: selected }))
})
