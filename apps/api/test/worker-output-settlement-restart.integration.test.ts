import { it } from 'vitest'
import { assertWorkerOutputSettlement } from './helpers/workerOutputSettlement.js'

it('recovers pending Worker output settlement after Main restarts', async () => {
  await assertWorkerOutputSettlement()
}, 240000)
