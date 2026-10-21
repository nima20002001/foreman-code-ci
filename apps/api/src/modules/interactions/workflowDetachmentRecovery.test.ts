import { afterEach, expect, it, vi } from 'vitest'
import { currentRestartUnit } from '../../../test/helpers/currentRestartUnit.js'

const fixtures: Array<ReturnType<typeof currentRestartUnit>> = []

async function fixture() {
  const f = currentRestartUnit(false)
  fixtures.push(f)
  const cold = f.cold()
  const generation = await cold.store.begin(f.execution())
  return { ...f, store: cold.store, generation }
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(f => f.connection.close()))
})

it('records a validated restart detachment on the saved generation and reuses it on readback', async () => {
  const f = await fixture()
  f.state.restartDetached = true
  const execution = structuredClone(f.execution())
  expect(await f.store.recoverDetached(f.owner, execution)).toEqual(f.session)
  expect(f.rows()).toHaveLength(1)
  expect(f.rows()[0]).toMatchObject({
    generation: f.generation, detached: true, detached_reference: f.session, closed: false,
  })
  expect(await f.store.recoverDetached(f.owner, execution)).toEqual(f.session)
  expect(f.state.closeWrites).toBe(1)
  expect(f.execution()).toEqual(execution)
  expect(f.state.attaches).toBe(0)
  expect(f.state.creates).toBe(0)
  expect(f.state.turns).toBe(0)
})

it('does not treat a saved session as physical restart detachment', async () => {
  const f = await fixture()
  expect(await f.store.recoverDetached(f.owner, f.execution())).toBeUndefined()
  expect(f.state.closeWrites).toBe(0)
  expect(f.rows()[0]?.detached).toBe(false)
})

it.each(['stopped', 'cleanup', 'finalized'] as const)(
  'does not reconstruct detachment after the workflow is %s', async field => {
    const f = await fixture()
    f.state.restartDetached = true
    f.state[field] = true
    expect(await f.store.recoverDetached(f.owner, f.execution())).toBeUndefined()
    expect(f.state.closeWrites).toBe(0)
    expect(f.rows()[0]?.detached).toBe(false)
  },
)

it('rejects a restart marker when the saved lifetime captures a different session', async () => {
  const f = await fixture()
  f.state.restartDetached = true
  f.rows()[0]!.expected_reference = { ...f.session, nativeSessionId: 'different-session' }
  await expect(f.store.recoverDetached(f.owner, f.execution()))
    .rejects.toMatchObject({ code: 'NATIVE_WORKFLOW_CLOSURE_CONFLICT' })
  expect(f.state.closeWrites).toBe(0)
  expect(f.rows()[0]?.detached).toBe(false)
})

it('does not detach a closed lifetime or cover an older lifetime that is still open', async () => {
  const f = await fixture()
  f.state.restartDetached = true
  const lifetime = f.rows()[0]!
  lifetime.closed = true
  lifetime.closed_reference = f.session
  expect(await f.store.recoverDetached(f.owner, f.execution())).toBeUndefined()
  lifetime.closed = false
  lifetime.closed_reference = null
  f.rows().push({ ...structuredClone(lifetime), generation: '2' })
  expect(await f.store.recoverDetached(f.owner, f.execution())).toBeUndefined()
  expect(f.state.closeWrites).toBe(0)
  expect(f.rows().every(row => !row.detached)).toBe(true)
})

it('rolls back reconstructed detachment when the Run owner changes before commit', async () => {
  const f = await fixture()
  f.state.restartDetached = true
  vi.spyOn(f.owner, 'readOneShotFence')
    .mockResolvedValueOnce({ ownerId: 'original-owner', fence: '1' })
    .mockResolvedValue({ ownerId: 'replacement-owner', fence: '2' })
  await expect(f.store.recoverDetached(f.owner, f.execution()))
    .rejects.toMatchObject({ code: 'NATIVE_WORKFLOW_CLOSURE_CONFLICT' })
  expect(f.state.closeWrites).toBe(0)
  expect(f.rows()[0]?.detached).toBe(false)
})
