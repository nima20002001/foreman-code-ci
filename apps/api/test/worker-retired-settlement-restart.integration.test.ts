import { it } from 'vitest'
import { assertWorkerOutputSettlement } from './helpers/workerOutputSettlement.js'

it('finishes Main closure from retained Worker readback after retirement and a crash', async () => {
  await assertWorkerOutputSettlement('retired')
}, 240000)
