import { randomUUID } from 'node:crypto'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { admitRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { readAcceptedPlacement } from '../src/modules/placement/persistence.js'
import { agent3Database } from './helpers/wave25Agent3.js'
import { sch11Fixture, sch11DomainState, type Sch11Database } from './helpers/sch11Fixture.js'
import { schedulePlacementFixture } from './helpers/schedulePlacementFixture.js'
import { join } from 'node:path'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { spawnOwnedStdioProcess } from '../src/modules/harnesses/process.js'
import { createRequire } from 'node:module'
import { diagnosticEnvironment, parseInstalledVersion } from '../src/modules/harnesses/compatibility/probe.js'

describe('native scheduled placement recovery', () => {
  let database: Sch11Database
  beforeAll(async () => {
    database = await agent3Database(process.env.ENG03_A_TEST_DATABASE_URL ?? process.env.WAVE25_TEST_DATABASE_URL)
  }, 60_000)
  afterAll(async () => { await database?.close() })

  it.each(['node', 'codex'] as const)('closes an owned %s diagnostic after its direct child exits', async (harness) => {
    const registry = new NativeProcessRegistry(join(database.directory, 'diagnostic-processes'))
    const recovery = await registry.reserveLaunch(`version-diagnostic:${harness}`)
    const errors: Error[] = []
    const binary = harness === 'node' ? process.execPath
      : createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')
    const args = harness === 'node' ? ['-e', 'process.stdout.write("diagnostic complete\\n")'] : ['--version']
    const diagnostic = await spawnOwnedStdioProcess({
      binary, args, cwd: database.directory,
      environment: diagnosticEnvironment(database.directory, process.env), recovery,
      onError: error => { errors.push(error) },
    })
    let output = ''
    let stderr = ''
    diagnostic.child.stdout.on('data', chunk => { output += String(chunk) })
    diagnostic.child.stderr.on('data', chunk => { stderr += String(chunk) })
    diagnostic.child.stdin.end()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The owned diagnostic did not close after exiting.')), 5_000)
    })
    try {
      const exit = await Promise.race([diagnostic.closed, deadline])
      expect(exit, `${harness} diagnostic stdout: ${output}\nstderr: ${stderr}`)
        .toEqual({ exitCode: 0, exitSignal: null })
      if (harness === 'node') expect(output).toBe('diagnostic complete\n')
      else expect(parseInstalledVersion(output, '')).toBe('0.154.0')
      expect(errors).toEqual([])
    } finally {
      clearTimeout(timer)
      await diagnostic.close()
    }
    expect(await registry.closeOwner(recovery.owner)).toBe(true)
  }, 15_000)

  it('admits a pending Once once after restart, inventory recovery and native qualification', async () => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
    fixture.configurations[0]!.harness = { harness: 'codex', model: process.env.ENG03_CODEX_MODEL ?? 'gpt-5.6-luna',
      reasoningEffort: 'medium', serviceTier: 'standard', sandbox: 'read-only' }
    const f = await sch11Fixture(database, undefined, fixture)
    const placement = await schedulePlacementFixture(f)
    const dispatch = () => f.dispatcher(async (principal, input, schedule) => {
      await admitRepeatRun(database.pool, f.locations, principal, 'schedule', input,
        { ...repeatStartPublication, placementAdmission: placement.producer }, { schedule })
    })
    try {
      await placement.harness.qualify()
      const saved = await placement.save()
      f.time.now = saved.nextOccurrenceAt!
      placement.restart()
      const pending = await sch11DomainState(f)
      await expect(dispatch().dispatch(saved)).rejects.toMatchObject({ code: 'HARNESS_INVENTORY_UNAVAILABLE' })
      expect(await sch11DomainState(f)).toEqual(pending)
      await placement.recover()
      await placement.harness.qualify()
      await dispatch().dispatch((await f.current())!)
      const history = await f.history()
      expect(history).toEqual([expect.objectContaining({ status: 'accepted', reason: null, dueAt: saved.nextOccurrenceAt })])
      const accepted = history[0]!
      if (accepted.status !== 'accepted') throw new Error('Expected accepted scheduled Run.')
      expect(await readAcceptedPlacement(database.pool, accepted.runId, fixture.version.entryNodeId)).toMatchObject({
        hostRef: placement.policy.hostRef, source: { ...placement.source, rootId: placement.root.binding.rootId },
        payload: { kind: 'agent', instanceRevision: '1' },
      })
      expect((await f.current())?.nextOccurrenceAt).toBeNull()
      await dispatch().dispatch(saved)
      expect(await f.history()).toEqual(history)
      expect(await f.countRuns()).toBe(1)
    } finally { placement.harness.registry.stop() }
  }, 600_000)
})
