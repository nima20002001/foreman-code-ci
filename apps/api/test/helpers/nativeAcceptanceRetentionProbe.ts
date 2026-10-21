import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { runEng03NativeScenario, type Eng03NativeControl } from './eng03NativeAcceptance.js'
import { waitForStartedBranches } from './nativeAcceptanceState.js'
import { ownedTestPath } from './testResources.js'

const [observation] = process.argv.slice(2)
if (!observation) throw new Error('An owned retention report path is required')
ownedTestPath(observation)
const state: { context?: Eng03NativeControl; branchCount: number; reserved: boolean } = {
  branchCount: 0, reserved: false,
}
let failure: unknown
try {
  await runEng03NativeScenario('E03-P01', 'codex', 'codex', {
    control: async current => {
      state.context = current
      const started = await waitForStartedBranches(current)
      assert.equal(started.length, 2)
      assert.equal(new Set(started.map(item => item.native_session_id)).size, 2)
      state.branchCount = started.length
      assert.equal(await current.stop(), true)
      // Stop may reject the active Start; the persisted canceled Run is its outcome.
      await Promise.allSettled([current.startTask])
      assert.equal((await current.runs.get(current.runId))?.outcome, 'canceled')
      await current.registry.reserveLaunch('acceptance-cleanup-recovery')
      state.reserved = true
    },
  })
} catch (error) { failure = error }
assert.ok(failure instanceof Error && failure.message.includes('cleanup remains unconfirmed'))
const context = state.context
assert.ok(context && state.reserved, 'Acceptance helper did not reach the recovery cut')
const artifact = JSON.parse(await readFile(context.artifactPath, 'utf8')) as { resourcesRetained: boolean }
assert.equal(artifact.resourcesRetained, true)
await writeFile(observation, JSON.stringify({ runId: context.runId, artifactPath: context.artifactPath,
  branchCount: state.branchCount }),
  { mode: 0o600, flag: 'wx' })
