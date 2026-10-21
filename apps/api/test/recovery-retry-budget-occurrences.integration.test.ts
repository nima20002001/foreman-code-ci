import { expect, it } from 'vitest'
import { attempts, describeRetryBudget, occurrences, sameSlot } from './helpers/retryBudget.js'
import {
  executionRows, readback, recoveryFixture,
  type Form,
} from './helpers/eng06DRecovery.js'

const forms: Form[] = ['repeat', 'sequential']

describeRetryBudget('finite technical retry budget: occurrences', () => {
  it.each(forms)('%s: each successful business occurrence has its own bounded technical attempts and frozen input', async (form) => {
    const f = await recoveryFixture(form, (submission) => submission.request.workflowNodeId.endsWith('-0') && submission.attempt === 1
      ? 'retryable_failure' : 'success')
    try {
      f.launch()
      await f.settled(f.base.f.run.id, form === 'repeat' ? { pollIntervalMs: 50 } : undefined)
      const view = await readback(f), rows = await executionRows(f), rounds = form === 'repeat' ? 3 : 1
      expect(view.record.run, JSON.stringify(f.diagnostics())).toMatchObject({ executionState: 'completed', outcome: 'succeeded', result: { outcome: 'succeeded' } })
      expect(rows).toHaveLength(rounds * 3)
      const entry = rows.filter((row) => row.execution.workflowNodeId === f.base.f.version.entryNodeId)
      const slots = new Set(entry.map((row) => row.slot_id))
      expect(slots.size).toBe(rounds)
      for (const slot of slots) {
        const group = entry.filter((row) => row.slot_id === slot)
        expect(attempts(group)).toEqual([1, 2]); sameSlot(group)
        expect(group.find((row) => row.execution.attempt === 1)!.execution.result?.outcome).toBe('failed')
        expect(group.find((row) => row.execution.attempt === 2)!.execution.result?.outcome).toBe('succeeded')
      }
      const exits = rows.filter((row) => row.execution.workflowNodeId !== f.base.f.version.entryNodeId)
      expect(exits).toHaveLength(rounds)
      expect(exits.every((row) => row.execution.attempt === 1)).toBe(true)
      const persisted = await occurrences(f)
      expect(persisted.map((row) => Number(row.occurrence_index))).toEqual(form === 'repeat' ? [1, 2, 3] : [])
      if (form === 'repeat') {
        expect(f.base.f.version.definition.repeat!.blocks[0]!.maxOccurrences).toBe(3)
        expect(new Set(entry.map((row) => row.input.occurrence?.identity.occurrenceIndex))).toEqual(new Set([1, 2, 3]))
      } else {
        expect(f.base.f.version.definition).not.toHaveProperty('repeat')
        for (const row of rows) { expect(row.input.occurrence).toBeNull(); expect(row.input.entry).toBeNull() }
      }
      expect(f.provider.counts.starts).toBe(rows.length)
      expect(f.provider.counts.sessions).toBe(rows.length)
      // Failed attempts must never become downstream accepted predecessor inputs.
      for (const row of exits) {
        expect(row.input.predecessors).toHaveLength(1)
        expect(row.input.predecessors[0]!.execution.attempt).toBe(2)
        expect(row.input.predecessors[0]!.acceptedResult.outcome).toBe('succeeded')
      }
    } finally { await f.close() }
  }, 150000)
})
