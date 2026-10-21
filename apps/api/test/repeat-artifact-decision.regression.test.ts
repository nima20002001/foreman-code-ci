import { describe, expect, it } from 'vitest'
import { RepeatWorkflowVersionV1Schema } from '@foreman-code/contracts/wave25'
import { parseWorkflowArtifactResult } from '@foreman-code/contracts/workflow-artifact-result'
import type { RepeatRepositoryHost } from '../src/modules/runs/repeatPostgres.js'
import { normalizeRepeatTerminal } from '../src/modules/runs/repeatNode.js'
import { repeatDigest } from '../src/modules/runs/repeatResolution.js'
import { createRepeatHarness, makeSimpleRepeatFixture, repeatExitOutput } from './helpers/eng04RepeatFixtures.js'

function artifactHarness() {
  const fixture = makeSimpleRepeatFixture(2, { suffix: 'f01-artifact-decision' })
  fixture.version = RepeatWorkflowVersionV1Schema.parse({ ...fixture.version, definition: { ...fixture.version.definition,
    nodes: fixture.version.definition.nodes.map(node => node.id === 'review'
      ? { ...node, artifactOutputs: { version: 1, outputKeys: ['report'] } } : node),
  } })
  const harness = createRepeatHarness(fixture)
  const publications = new Map<string, string>()
  // Adapt only the deterministic fixture's artifact port; preserve its existing
  // authority, settlement, owner and publication hooks. This is SQL-adapter
  // coverage of the real repository, not PostgreSQL or native-provider proof.
  const host = Reflect.get(harness.store, 'host') as RepeatRepositoryHost
  const open = host.openLocked.bind(host)
  host.openLocked = async (...args) => ({ ...await open(...args),
    assertWorkflowArtifactOutputsLocked: async (_sql, execution) => {
      const exit = fixture.version.definition.nodes.find(node => node.id === execution.workflowNodeId)!
      if (exit.kind === 'job') throw new Error('Agent fixture required')
      const envelope = parseWorkflowArtifactResult(execution.result, exit.artifactOutputs!, exit.choice!)
      for (const output of envelope.artifactOutputs.outputs) {
        if (publications.get(output.commandId) !== execution.id) throw new Error('ARTIFACT_PUBLICATION_MISSING')
      }
    },
  })
  return { harness, publications }
}

describe('F-01 repeat artifact result acceptance and recovery', () => {
  it.each(['pass', 'issues'] as const)('preserves original results through continuation and final %s exit', async outcome => {
    const { harness, publications } = artifactHarness()
    let occurrence = await harness.enter()
    let previousResult: unknown
    let previousDigest: string | undefined
    for (const [index, selected] of [[1, 'issues'], [2, outcome]] as const) {
      const work = await harness.admit(occurrence, 'work')
      if (index === 2) expect(work.input).toMatchObject({ entry: { carry: {
        acceptedResult: previousResult, acceptedResultDigest: previousDigest,
      } } })
      harness.finish(work.id)
      await harness.accept(work.id)
      const review = await harness.admit(occurrence, 'review')
      const commandId = `publish-report-${index}`
      const output = { text: JSON.stringify({ ...repeatExitOutput(index, selected),
        artifactOutputs: { version: 1, outputs: [{ outputKey: 'report', commandId }] },
      }, null, 2) }
      const completed = harness.finish(review.id, output)
      const original = structuredClone(completed.result)
      const digest = repeatDigest(original)
      expect(normalizeRepeatTerminal(harness.fixture.version, harness.fixture.scope,
        { nodeId: 'review', occurrence: occurrence.identity }, completed)).toEqual(completed)
      // A parsed association alone must not satisfy durable publication.
      await expect(harness.accept(review.id)).rejects.toThrow('ARTIFACT_PUBLICATION_MISSING')
      expect(harness.state().results.has(review.id)).toBe(false)
      publications.set(commandId, review.id)
      const accepted = await harness.accept(review.id)
      expect(accepted).toMatchObject({ kind: 'resolved' })
      if (accepted.kind !== 'resolved') throw new Error('Expected repeat decision resolution')
      const stored = harness.state().results.get(review.id)!
      expect(JSON.parse(stored.result_json)).toEqual(original)
      expect(stored.result_digest).toBe(digest)
      const recovered = harness.repository()
      const transition = await recovered.transition(occurrence.identity.occurrenceId)
      expect(transition.decision.acceptedResultDigest).toBe(digest)
      expect(transition.decision.reason).toBe(index === 1 ? 'repeat' : outcome === 'pass' ? 'early_exit' : 'limit_exit')
      const counts = { results: harness.state().results.size, decisions: harness.state().decisions.size,
        occurrences: harness.state().occurrences.size, publications: harness.state().publications.length }
      expect(await recovered.acceptTerminal(review.id)).toEqual({ kind: 'resolved', resolution: accepted.resolution })
      expect(await harness.repository().transition(occurrence.identity.occurrenceId)).toEqual(transition)
      expect({ results: harness.state().results.size, decisions: harness.state().decisions.size,
        occurrences: harness.state().occurrences.size, publications: harness.state().publications.length }).toEqual(counts)
      expect(harness.state().executions.get(review.id)!.record.result).toEqual(original)
      if (index === 1) {
        occurrence = transition.next!
        expect(occurrence.input.previous?.acceptedResultDigest).toBe(digest)
        previousResult = original
        previousDigest = digest
      } else expect(transition.next).toBeNull()
    }
  })
})
