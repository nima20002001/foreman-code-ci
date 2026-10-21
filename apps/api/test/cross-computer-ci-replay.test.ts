import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { verifyScenario } from './helpers/crossComputerCiVerification.js'

it('replays recorded cross-computer CI readback offline', async () => {
  const path = process.env.FOREMAN_CODE_CROSS_COMPUTER_CI_REPLAY
    ?? new URL('./fixtures/cross-computer-ci.json', import.meta.url)
  const recorded = JSON.parse(await readFile(path, 'utf8'))
  expect(() => verifyScenario(recorded)).not.toThrow()
})
