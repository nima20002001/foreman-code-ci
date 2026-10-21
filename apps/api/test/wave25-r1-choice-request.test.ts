import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, type HarnessExecutionRequest } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, parseChoiceResultEnvelope, type WorkflowChoice } from '@foreman-code/contracts/wave25'
import { buildHarnessPrompt } from '../src/modules/harnesses/prompt.js'
import { currentInitialPrompt } from '../src/modules/runs/currentRouting.js'
import { candidateFor } from './helpers/wave25Agent3.js'
import { repeatNativeObserver, type RepeatNativeObserverContext } from '../src/modules/runs/repeatRuntime.js'

const directories: string[] = []
afterEach(async () => { while (directories.length) await rm(directories.pop()!, { recursive: true, force: true }) })
const choice = (first = 'pass', second = 'issues'): WorkflowChoice => ({ outcomes: [
  { outcome: first, target: { kind: 'branch_end' } },
  { outcome: second, target: { kind: 'edge', relationshipId: 'private-edge' } },
] })

/** Exercises the real driver/request builder. Only the coordinator boundary is
 * synthetic here: this is NOT native acceptance, journal, or routing coverage. */
async function providerRequest(declaration: WorkflowChoice, selected = 0) {
  const f = makeCurrentWorkflowFixture('r1-choice-request')
  const directory = await mkdtemp(join(tmpdir(), 'wave25-r1-choice-')); directories.push(directory)
  const node = f.version.definition.nodes[0]!
  node.choice = declaration
  f.version.definition.edges[0]!.id = 'private-edge'
  delete node.initialPrompt
  const configuration = f.configurations[0]!
  const original = structuredClone(configuration)
  const run = { ...f.run, authorizationPrincipalId: 'request-author', executionLocation: { runnerId: 'local', rootPath: directory,
    locationRevision: 1, identityHash: `sha256:${'1'.repeat(64)}` } }
  const execution = HarnessExecutionSchema.parse({ ...candidateFor(f), state: 'starting',
    workingDirectory: directory, runtimeDirectory: join(directory, f.identities[0]!.executionId) })
  let captured: HarnessExecutionRequest | undefined, rendered = '', produced: unknown
  const native = {
    observeExact: vi.fn(async ({ request }: { request: HarnessExecutionRequest }) => {
      captured = request
      // Exactly what the native coordinator passes to the provider: no version-
      // table lookup, saved-choice access, or manually synchronized user prompt.
      rendered = buildHarnessPrompt(request)
      const text = /^Allowed routing\.outcome values: (.+)$/m.exec(rendered)?.[1]
      if (!text) throw new Error('The actual provider prompt omitted the saved output contract')
      const allowed: unknown = JSON.parse(text)
      if (!Array.isArray(allowed) || typeof allowed[selected] !== 'string') throw new Error('Invalid provider contract')
      produced = { outcome: 'succeeded', output: { routing: { outcome: allowed[selected] }, data: { observed: true } } }
      return { state: 'completed', execution: HarnessExecutionSchema.parse({ ...execution, state: 'completed',
        result: produced, finishedAt: new Date().toISOString() }), result: produced }
    }),
  }
  const store = { readExecution: vi.fn(async () => ({ execution, ref: { nodeId: node.id, occurrence: null } })),
    claimLaunch: vi.fn(async () => execution), assertExecutionAdmission: vi.fn(async () => undefined),
    beginNativeEntry: vi.fn(async () => undefined) }
  const signal = new AbortController().signal
  const context = {
    run, version: f.version, signal, owner: { runId: run.id, assertOwned: vi.fn() }, native,
    store, workflows: { getAgentConfiguration: async () => configuration },
    locations: { revalidateRunAuthorization: vi.fn(async () => undefined), revalidateSnapshot: vi.fn(async () => undefined) },
    admission: { run: async (_runId: string, _signal: AbortSignal, work: () => Promise<void>) => work() },
    directory: (id: string) => join(directory, id),
  } as unknown as RepeatNativeObserverContext
  await repeatNativeObserver(context)(execution, signal)
  expect(native.observeExact).toHaveBeenCalledTimes(1)
  expect(configuration).toEqual(original)
  expect(captured?.input).toEqual(execution.input)
  return { request: captured!, rendered, result: produced }
}

describe('BR1-007: immutable finite choices reach the actual request builder', () => {
  it.each([0, 1])('a provider using only its request can return declared outcome %s', async (selected) => {
    const declaration = choice(), observed = await providerRequest(declaration, selected)
    expect(observed.request.initialPrompt).toContain('Foreman Code finite-choice output contract (version 1)')
    expect(parseChoiceResultEnvelope(observed.result, declaration).routing.outcome).toBe(declaration.outcomes[selected]!.outcome)
    expect(observed.rendered).not.toContain('private-edge')
  })
  it('changing only the saved names changes the provider-visible output contract', async () => {
    const first = await providerRequest(choice('pass', 'issues'))
    const second = await providerRequest(choice('ready', 'revise'))
    expect(first.request.initialPrompt).not.toEqual(second.request.initialPrompt)
    expect(first.request.initialPrompt).toContain('["pass","issues"]')
    expect(second.request.initialPrompt).toContain('["ready","revise"]')
  })
  it('leaves ordinary node prompts unchanged', () => {
    expect(currentInitialPrompt({})).toBeUndefined()
    expect(currentInitialPrompt({ initialPrompt: 'Do the accepted task.' })).toBe('Do the accepted task.')
    const handoff = currentInitialPrompt({ initialPrompt: 'Review.', choice: { outcomes: [
      { outcome: 'send_to_d', target: { kind: 'edge', relationshipId: 'bd' } },
    ] } }, false, true)!
    expect(handoff).toContain('Foreman Code work-handoff result contract (version 1)')
    expect(handoff).toContain('"send_to_d"')
    expect(handoff).toContain('the exact request ID in your received work')
    expect(handoff).toContain('parentRequest.requestId')
    expect(handoff).toContain('work.request.requestId')
    expect(handoff.startsWith('Review.\n\n')).toBe(true)
  })
  it('preserves the authored task and never mutates the declaration', () => {
    const declaration = choice(), before = structuredClone(declaration)
    const combined = currentInitialPrompt({ initialPrompt: 'Publish and delegate.', choice: declaration,
      artifactOutputs: { version: 1, outputKeys: ['report'] } }, false, true)!
    expect(combined).toContain('exactly routing, data, and artifactOutputs')
    expect(combined).toContain('routing.kind is request, return, or finish')
    expect(combined).toContain('original native turn’s successful files.publish_transferred_result')
    expect(combined).toContain('latestDeliverable')
    expect(currentInitialPrompt({ initialPrompt: 'Check the implementation.', choice: declaration }))
      .toMatch(/^Check the implementation\.\n\nForeman Code finite-choice/)
    expect(declaration).toEqual(before)
  })
  it('explains direction waits and separates deferred verification from unresolved task work', () => {
    const node = { initialPrompt: 'Implement the fix. Do not run tests; another lane verifies it.' }
    const before = structuredClone(node)
    const prompt = currentInitialPrompt(node, false, true)!
    expect(prompt.startsWith(`${node.initialPrompt}\n\n`)).toBe(true)
    expect(prompt).toContain('Use [] when the assigned work is complete.')
    expect(prompt).toContain('non-empty remainingFindings makes the Run wait for owner direction')
    expect(prompt).toContain('intentionally deferred checks assigned to another lane')
    expect(prompt).toContain('They are remainingFindings only when they leave an assigned task requirement unresolved.')
    expect(prompt).toContain('report its existing commit and verification status in latestDeliverable')
    expect(node).toEqual(before)
  })
  it('keeps the derived instruction bounded at the schema maximum', () => {
    const declaration: WorkflowChoice = { outcomes: Array.from({ length: 16 }, (_, index) => ({
      outcome: `o${index.toString().padStart(2, '0')}${'x'.repeat(45)}`, target: { kind: 'branch_end' as const },
    })) }
    expect(Buffer.byteLength(currentInitialPrompt({ choice: declaration })!, 'utf8')).toBeLessThan(4096)
  })
  it('does not relax strict acceptance to compensate for the request fix', () => {
    const declaration = choice()
    for (const output of [
      { routing: { outcome: 'undeclared' }, data: null },
      { routing: { outcome: 'pass', edgeId: 'private-edge' }, data: null },
      { routing: { outcome: 'pass' }, data: null, extra: true },
      { routing: { outcome: 'pass' }, data: 'x'.repeat(65536) },
      '```json\n{"routing":{"outcome":"pass"},"data":null}\n```',
    ]) expect(() => parseChoiceResultEnvelope({ outcome: 'succeeded', output }, declaration)).toThrow()
  })
})
