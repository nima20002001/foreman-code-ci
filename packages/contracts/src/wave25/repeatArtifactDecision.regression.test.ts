import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture } from './currentFixture.js'
import { canonicalGraphJson } from './json.js'
import {
  RepeatWorkflowVersionV1Schema, parseRepeatExitResultV1, validateRepeatDecisionV1, validateRepeatSuccessorV1,
  type RepeatDecisionV1, type RepeatOccurrenceV1,
} from './repeat.js'

const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalGraphJson(value)).digest('hex')}`

function fixture(outcome: 'issues' | 'pass', index: number) {
  const base = makeCurrentWorkflowFixture('repeat-artifact-decision', 'repeat')
  const version = RepeatWorkflowVersionV1Schema.parse({ ...base.version, definition: { ...base.version.definition,
    nodes: base.version.definition.nodes.map((node, position) => position === 1
      ? { ...node, artifactOutputs: { version: 1, outputKeys: ['report'] } } : node),
  } })
  const exit = version.definition.nodes[1]!
  if (exit.kind === 'job') throw new Error('Agent fixture required')
  const data = { latestDeliverable: { revision: index }, remainingFindings: outcome === 'pass' ? [] : ['fix'] }
  const result = { outcome: 'succeeded', output: { text: JSON.stringify({ routing: { outcome }, data,
    artifactOutputs: { version: 1, outputs: [{ outputKey: 'report', commandId: `publish-report-${index}` }] },
  }, null, 2) } }
  const occurrence: RepeatOccurrenceV1 = { contractVersion: 1,
    identity: { scope: base.scope, blockId: 'repair', occurrenceId: `occurrence-${index}`, occurrenceIndex: index },
    input: { bindingId: `binding-${index}`, inputDigest: digest({ index }), previous: index === 1 ? null : {
      occurrenceId: `occurrence-${index - 1}`, occurrenceIndex: index - 1,
      decisionId: `decision-${index - 1}`, acceptedResultDigest: digest({ previous: index - 1 }),
    } },
  }
  const reason = outcome === 'pass' ? 'early_exit' : index === 3 ? 'limit_exit' : 'repeat'
  const decision: RepeatDecisionV1 = { contractVersion: 1, decisionId: `decision-${index}`, occurrence,
    exitExecution: { ...base.identities[1]!, occurrence: occurrence.identity }, acceptedResultDigest: digest(result),
    outcome, reason, target: reason === 'repeat'
      ? { kind: 'next_occurrence', entryNodeId: version.entryNodeId, occurrenceIndex: index + 1 } : { kind: 'branch_end' },
    decidedAt: base.createdAt, resultData: data,
  }
  return { version, exit, result, decision }
}

describe('F-01 immutable repeat artifact decision declaration', () => {
  it.each([
    ['issues', 1, 'repeat'], ['pass', 1, 'early_exit'], ['issues', 3, 'limit_exit'],
  ] as const)('validates the original artifact result for %s at occurrence %i (%s)', (outcome, index, reason) => {
    const f = fixture(outcome, index)
    const original = canonicalGraphJson(f.result)
    expect(parseRepeatExitResultV1(f.result, f.exit.choice!, f.exit.artifactOutputs).data).toEqual(f.decision.resultData)
    expect(validateRepeatDecisionV1(f.version, f.decision, f.result)).toEqual(f.decision)
    expect(f.decision.reason).toBe(reason)
    expect(canonicalGraphJson(f.result)).toBe(original)
    expect(f.decision.acceptedResultDigest).toBe(digest(f.result))
  })

  it('revalidates a successor against the same original result and digest', () => {
    const f = fixture('issues', 1)
    const next: RepeatOccurrenceV1 = { contractVersion: 1,
      identity: { ...f.decision.occurrence.identity, occurrenceId: 'occurrence-2', occurrenceIndex: 2 },
      input: { bindingId: 'binding-2', inputDigest: digest({ next: 2 }), previous: {
        occurrenceId: 'occurrence-1', occurrenceIndex: 1,
        decisionId: f.decision.decisionId, acceptedResultDigest: f.decision.acceptedResultDigest,
      } },
    }
    expect(validateRepeatSuccessorV1(f.version, f.decision, next, f.result)).toEqual(next)
    expect(() => validateRepeatSuccessorV1(f.version, f.decision, {
      ...next, input: { ...next.input, previous: { ...next.input.previous!, acceptedResultDigest: digest('other') } },
    }, f.result)).toThrow('REPEAT_SUCCESSOR_PROVENANCE_INVALID')
  })

  it('still rejects absent or different saved artifact declarations', () => {
    const f = fixture('issues', 1)
    for (const artifactOutputs of [undefined, { version: 1, outputKeys: ['other'] }]) {
      const version = { ...f.version, definition: { ...f.version.definition,
        nodes: f.version.definition.nodes.map(node => node.id === f.exit.id ? { ...node, artifactOutputs } : node),
      } }
      expect(() => validateRepeatDecisionV1(version, f.decision, f.result)).toThrow()
    }
  })
})
