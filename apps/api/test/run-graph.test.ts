import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { ExclusiveGraphConnection, beforeGraphCommit, type GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { RunGraphError } from '../src/modules/run-graph/errors.js'
import { deferred } from './helpers/deferred.js'

function client(query: (text: string) => Promise<unknown> = async () => ({ rows: [], rowCount: 0 })) {
  return { query: vi.fn(query) } as unknown as pg.ClientBase
}

describe('exclusive graph transaction port (unit, not PostgreSQL proof)', () => {
  it('serializes a whole transaction against ordinary owner-client queries', async () => {
    const entered = deferred(), release = deferred(), trace: string[] = []
    const raw = client(async (text) => {
      trace.push(text)
      if (text === 'select blocked') { entered.resolve(); await release.promise }
      return { rows: [], rowCount: 0 }
    })
    const connection = new ExclusiveGraphConnection(raw, () => undefined)
    try {
      const first = connection.transaction(async (sql) => { await sql.query('select blocked'); await sql.query('select after') })
      await entered.promise
      const second = connection.query('select ordinary')
      expect(trace).toEqual(['begin isolation level read committed', 'select blocked'])
      release.resolve()
      await Promise.all([first, second])
      expect(trace).toEqual(['begin isolation level read committed', 'select blocked', 'select after', 'commit', 'select ordinary'])
    } finally { release.resolve(); await connection.close() }
  })
  it('rejects duplicate raw-client adoption, nested transactions and manual transaction control', async () => {
    const raw = client(), connection = new ExclusiveGraphConnection(raw, () => undefined)
    try {
      expect(() => new ExclusiveGraphConnection(raw, () => undefined)).toThrow('GRAPH_TRANSACTION_CONCURRENT')
      await expect(connection.transaction(async () => connection.transaction(async () => undefined))).rejects.toThrow('GRAPH_TRANSACTION_NESTED')
      await expect(connection.transaction(async (sql) => { await sql.query('/* no escape */ commit') })).rejects.toThrow('GRAPH_TRANSACTION_NESTED')
    } finally { await connection.close() }
  })
  it('never lends a transaction port after callback completion', async () => {
    const connection = new ExclusiveGraphConnection(client(), () => undefined)
    let escaped!: GraphTransactionSql
    try {
      await connection.transaction(async (sql) => { escaped = sql })
      await expect(escaped.query('select 1')).rejects.toThrow('GRAPH_TRANSACTION_CLOSED')
    } finally { await connection.close() }
  })
  it('poisons the transaction after a caught SQL failure', async () => {
    const trace: string[] = []
    const connection = new ExclusiveGraphConnection(client(async (text) => {
      trace.push(text)
      if (text === 'select invalid') throw new Error('database rejected statement')
      return { rows: [], rowCount: 0 }
    }), () => undefined)
    try {
      await expect(connection.transaction(async (sql) => { await sql.query('select invalid').catch(() => undefined) })).rejects.toThrow('GRAPH_TRANSACTION_FAILED')
      expect(trace.at(-1)).toBe('rollback')
      expect(trace).not.toContain('commit')
    } finally { await connection.close() }
  })
  it('rejects concurrent statements rather than interleaving them', async () => {
    const entered = deferred(), release = deferred()
    const connection = new ExclusiveGraphConnection(client(async (text) => {
      if (text === 'select blocked') { entered.resolve(); await release.promise }
      return { rows: [], rowCount: 0 }
    }), () => undefined)
    try {
      const transaction = connection.transaction(async (sql) => {
        const pending = sql.query('select blocked')
        await entered.promise
        await expect(sql.query('select overlap')).rejects.toThrow('GRAPH_TRANSACTION_CONCURRENT')
        release.resolve()
        await pending
      })
      await expect(transaction).rejects.toThrow('GRAPH_TRANSACTION_FAILED')
    } finally { release.resolve(); await connection.close() }
  })
  it('finalizes publication before commit and retires an uncertain commit connection', async () => {
    const trace: string[] = []
    const failure = new Error('commit response lost')
    const connection = new ExclusiveGraphConnection(client(async (text) => {
      trace.push(text)
      if (text === 'commit') throw failure
      return { rows: [], rowCount: 0 }
    }), () => undefined)
    const work = vi.fn(async (sql: GraphTransactionSql) => {
      await sql.query('select domain_mutation')
      beforeGraphCommit(sql, async () => { await sql.query('select publication') })
    })
    try {
      await expect(connection.transaction(work)).rejects.toThrow('commit response lost')
      expect(trace).toEqual(['begin isolation level read committed', 'select domain_mutation', 'select publication', 'commit', 'rollback'])
      expect(connection.unusable).toBe(true)
      await expect(connection.query('select again')).rejects.toThrow('GRAPH_TRANSACTION_FAILED')
      await expect(connection.query('select diagnostic')).rejects.toMatchObject({ cause: failure })
      expect(work).toHaveBeenCalledTimes(1)
    } finally { await connection.close() }
  })
  it('checks singleton-owner liveness and does not confer ownership itself', async () => {
    let owned = true
    const connection = new ExclusiveGraphConnection(client(), () => { if (!owned) throw new RunGraphError('GRAPH_OWNER_LOST') })
    try {
      await expect(connection.transaction(async () => { owned = false })).rejects.toThrow('GRAPH_OWNER_LOST')
    } finally { await connection.close() }
  })
  it('rejects an already-open outer transaction when the driver exposes transaction status', async () => {
    const raw = Object.assign(client(), { getTransactionStatus: () => 'T' })
    const connection = new ExclusiveGraphConnection(raw, () => undefined)
    try {
      await expect(connection.transaction(async () => undefined)).rejects.toThrow('GRAPH_TRANSACTION_NESTED')
      expect(raw.query).not.toHaveBeenCalled()
    } finally { await connection.close() }
  })
})
