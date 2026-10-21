import { describe, expect, it } from 'vitest'

import { normalizeRepeatTerminal } from '../src/modules/runs/repeatNode.js'
import { repeatExecutionDriver } from '../src/modules/runs/repeatRuntime.js'
import {
  createRepeatHarness,
  firstOccurrence,
  makeSimpleRepeatFixture,
  repeatExitOutput,
  successfulExecution,
  executionFor,
} from './helpers/eng04RepeatFixtures.js'

const providerShapes = [
  {
    harness: 'codex',
    providerVersion: 'codex-provider-shaped-0.154.0',
    nativeSessionId: 'codex-session-eng04-d-0001',
    nativeTurnId: 'codex-turn-eng04-d-0001',
    nativeRequestId: 'codex-request-eng04-d-0001',
  },
  {
    harness: 'claude',
    providerVersion: 'claude-provider-shaped-current',
    nativeSessionId: 'claude-session-eng04-d-0001',
    nativeTurnId: 'claude-turn-eng04-d-0001',
    nativeRequestId: 'claude-request-eng04-d-0001',
  },
] as const

describe('NIM-2648 ENG04-D provider-shaped observation regression', () => {
  it.each(providerShapes)('coalesces concurrent duplicate $harness observation by exact execution ID without inventing provider evidence', async (trace) => {
    const fixture = makeSimpleRepeatFixture(1, { suffix: 'eng04-d-provider' })
    const harness = createRepeatHarness(fixture)
    const occurrence = await harness.enter()
    const execution = await harness.admit(occurrence, 'work', `${trace.harness}-execution-eng04-d-0001`)
    const observed: Array<typeof trace & { executionId: string }> = []
    let release!: () => void
    const boundary = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const observationStarted = new Promise<void>((resolve) => { started = resolve })
    const driver = repeatExecutionDriver({
      scope: fixture.scope,
      version: fixture.version,
      owner: harness.owner,
      store: harness.store,
      abandonAttempt: async () => { throw new Error('Unexpected start failure') },
      observeExact: async (stored) => {
        observed.push({ ...trace, executionId: stored.id })
        started()
        await boundary
        harness.finish(stored.id, { rawProviderResultId: `${trace.harness}-observed-result` })
      },
    })
    const signal = new AbortController().signal
    const first = driver.observe(execution, signal)
    const duplicate = driver.observe({ ...execution, input: { checkpointNoise: true } }, signal)
    await observationStarted
    expect(observed).toEqual([{ ...trace, executionId: execution.id }])
    release()
    await Promise.all([first, duplicate])
    expect(observed).toHaveLength(1)
    expect(observed[0]!.nativeSessionId).toBe(trace.nativeSessionId)
    expect(observed[0]!.nativeTurnId).toBe(trace.nativeTurnId)
    expect(observed[0]!.nativeRequestId).toBe(trace.nativeRequestId)
  })

  it('fails closed when a provider-shaped successful terminal hides the repeat envelope inside prose/text', () => {
    const fixture = makeSimpleRepeatFixture(2)
    const occurrence = firstOccurrence(fixture).occurrence
    const ref = { nodeId: 'review', occurrence: occurrence.identity }
    const validOutput = repeatExitOutput(1, 'issues')
    const textCarried = successfulExecution(executionFor(fixture, 'review', 'raw-provider-text-terminal'), {
      text: `provider prefix ${JSON.stringify(validOutput)} provider suffix`,
      rawProviderResultId: 'provider-result-text-0001',
    })
    const normalized = normalizeRepeatTerminal(fixture.version, fixture.scope, ref, textCarried)
    expect(normalized.result?.outcome).toBe('failed')
    expect(normalized).not.toEqual(textCarried)
  })

  // Persisted readback and denied callers use the current authenticated graph
  // API in eng04-b-graph-read-qualification.integration.test.ts.
})
