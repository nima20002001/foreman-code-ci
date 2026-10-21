import { expect, it } from 'vitest'
import * as commands from './postgres.js'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { NativeConversationControlCommands } from '../conversations/nativeControlCommands.js'

interface Receipt {
  principalId: string
  operation: string
  commandId: string
  createdAt: number
  completedAt?: number
  status: string | null
  hasAcceptedControl: boolean
  hasAcknowledgment: boolean
}

const now = Date.parse('2026-10-16T00:00:00.000Z')
function receipt(commandId: string, changes: Partial<Receipt> = {}): Receipt {
  return { principalId: 'operator', operation: 'workflow.update', commandId,
    createdAt: now - 31 * 86_400_000, status: null, hasAcceptedControl: false,
    hasAcknowledgment: false, ...changes }
}

function store(initial: Receipt[]) {
  const records = new Map(initial.map(row => [row.commandId, row]))
  const fences = new Set<string>()
  const pages: number[] = []
  return { records, fences, pages,
    port: {
      async candidates(limit: number) {
        pages.push(limit)
        return [...records.values()].slice(0, limit)
      },
      async remove(row: Receipt) {
        if (records.get(row.commandId) !== row) return false
        fences.add(row.commandId)
        records.delete(row.commandId)
        return true
      },
    },
  }
}

it('expires completed retry snapshots after thirty days while retaining fresh, unresolved and permanent records', async () => {
  const kept = [
    receipt('fresh', { createdAt: now - 29 * 86_400_000 }),
    receipt('boundary', { createdAt: now - 30 * 86_400_000 }),
    receipt('recently-completed', { completedAt: now - 86_400_000 }),
    receipt('pending', { operation: 'agent_chat_control', status: 'pending' }),
    receipt('uncertain', { operation: 'operator_chat_control', status: 'uncertain' }),
    receipt('unacknowledged', { operation: 'agent_chat_control', status: 'completed', hasAcceptedControl: true }),
    receipt('binding', { operation: 'job.inputs.bind' }),
    receipt('artifact', { operation: 'remote.native-artifact.output' }),
    receipt('workflow-version', { operation: 'workflow.save.v3' }),
    receipt('repository-location-recovery', { operation: 'workspace.location.set' }),
    receipt('future-operation', { operation: 'unrecognized' }),
  ]
  const expired = [receipt('ordinary'), receipt('control', {
    operation: 'agent_chat_control', status: 'completed', hasAcceptedControl: true, hasAcknowledgment: true,
  })]
  const f = store([...kept, ...expired])
  expect(await commands.pruneCompletedCommandReceipts(f.port, now)).toBe(2)
  expect([...f.records.keys()]).toEqual(kept.map(row => row.commandId))
  expect([...f.fences]).toEqual(expired.map(row => row.commandId))
})

it('removes at most one hundred receipts per cleanup call', async () => {
  const f = store(Array.from({ length: 105 }, (_, index) => receipt(`command-${index}`)))
  expect(await commands.pruneCompletedCommandReceipts(f.port, now)).toBe(100)
  expect(f.records.size).toBe(5)
  expect(f.pages).toEqual([100])
  expect(await commands.pruneCompletedCommandReceipts(f.port, now)).toBe(5)
  expect(f.records.size).toBe(0)
})

it('propagates cleanup storage failures without reporting deletion', async () => {
  const f = store([receipt('command')])
  f.port.remove = async () => { throw new Error('storage unavailable') }
  await expect(commands.pruneCompletedCommandReceipts(f.port, now)).rejects.toThrow('storage unavailable')
  expect(f.records.size).toBe(1)
})

it('never performs an old command again when its response was removed but its successful audit remains', async () => {
  const principal: ManagementPrincipal = { id: 'operator', name: 'Operator', audience: 'operator', grants: [],
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  const responses = [[], [], [], [{ command_id: 'old-command' }]]
  const client = { query: async () => ({ rows: responses.shift() ?? [], rowCount: 0 }), release() {} }
  const pool = { connect: async () => client } as unknown as pg.Pool
  let performed = false
  const coordinator = new commands.PostgresCommandCoordinator(pool)
  await expect(coordinator.execute({ principal, source: 'http', operation: 'workflow.update',
    commandId: 'old-command', targetKey: 'workflow', payload: {}, perform: async () => {
      performed = true
      return { updated: true }
    },
  })).rejects.toMatchObject({ code: 'COMMAND_RESULT_EXPIRED', status: 409 })
  expect(performed).toBe(false)
})

it('reports an expired native control response without repeating its effect', async () => {
  const principal: ManagementPrincipal = { id: 'operator', name: 'Operator', audience: 'operator', grants: [],
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  const responses = [[], [], [{ command_id: 'old-control' }]]
  const pool = { query: async () => ({ rows: responses.shift() ?? [], rowCount: 0 }) } as unknown as pg.Pool
  const controls = new NativeConversationControlCommands(pool, {
    operation: 'operator_chat_control', parse: value => value, prefix: 'CHAT', label: 'Chat',
  })
  let performed = false
  await expect(controls.execute(principal, 'http', 'conversation', 'old-control', {}, async () => {
    performed = true
    return { completed: true }
  })).rejects.toMatchObject({ code: 'COMMAND_RESULT_EXPIRED', status: 409 })
  expect(performed).toBe(false)
})
