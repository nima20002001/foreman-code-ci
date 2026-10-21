import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { expectCiPreparationOutsideTransaction } from './helpers/ciPreparationTransactions.js'

const commandKey = 'command:fixture-operator:ci.run:slow-resolution'
const resolver = { pid: 11, xact_start: null, owns_command: true }
const background = { pid: 12, xact_start: new Date('2026-01-01T00:00:00Z'), owns_command: false }

function snapshot(rows: unknown[]) {
  return { query: vi.fn(async () => ({ rows })) } as unknown as pg.Pool
}

it('accepts a resolver holding its command lock outside a transaction', async () => {
  await expectCiPreparationOutsideTransaction(snapshot([resolver]), commandKey)
})

it('accepts an idle resolver while unrelated work has an implicit transaction', async () => {
  await expectCiPreparationOutsideTransaction(snapshot([background, resolver]), commandKey)
})

it('rejects a resolver that retains a transaction while background work is idle', async () => {
  const sessions = [{ ...background, xact_start: null }, { ...resolver, xact_start: background.xact_start }]
  await expect(expectCiPreparationOutsideTransaction(snapshot(sessions), commandKey)).rejects.toThrow()
})

it('rejects a missing resolver instead of passing an empty transaction count', async () => {
  await expect(expectCiPreparationOutsideTransaction(snapshot([]), commandKey)).rejects.toThrow()
})

it('rejects an ambiguous command owner', async () => {
  await expect(expectCiPreparationOutsideTransaction(snapshot([resolver, { ...resolver, pid: 13 }]), commandKey))
    .rejects.toThrow()
})
