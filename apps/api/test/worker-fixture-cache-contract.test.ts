import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { cachedWorkerRelease } from '../../../scripts/test-fixture-cache.mjs'

it('rejects an invalid source revision before building or publishing a Worker fixture', async () => {
  const repository = fileURLToPath(new URL('../../../', import.meta.url))
  await expect(cachedWorkerRelease(
    'unused-fixture-cache', repository, 'invalid:revision:syntax', ['target', 'host'], async directory => {
      throw new Error(`Unexpected fixture build in ${directory}`)
    },
  )).rejects.toThrow()
})
