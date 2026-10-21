import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { AcceptedProviderAccountBindings } from '../src/modules/provider-accounts/acceptedBindings.js'
import { admitRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { startSqlFixture } from './eng04-start-fixtures.js'

afterEach(() => vi.useRealTimers())

function singleConnection(f: ReturnType<typeof startSqlFixture>) {
  const connect = f.pool.connect.bind(f.pool)
  let held = false
  f.pool.connect = (async () => {
    if (held) throw new Error('Pool connection unavailable')
    held = true
    const client = await connect()
    const release = client.release.bind(client)
    client.release = (destroy?: boolean) => { held = false; release(destroy) }
    return client
  }) as pg.Pool['connect']
}

it.each(['http', 'mcp'] as const)('%s releases the preparation connection before resolving accounts', async source => {
  const f = startSqlFixture()
  singleConnection(f)
  let prepared = 0
  const accounts = {
    async prepare() {
      const client = await f.pool.connect()
      try { prepared++ } finally { client.release() }
      return undefined
    },
    async acceptMany() { return new Map() },
  } as unknown as AcceptedProviderAccountBindings
  const result = await admitRepeatRun(f.pool, f.locations, f.principal, source, f.request,
    { ...f.publication, accountBindings: accounts })
  expect(prepared).toBe(f.configurations.length)
  expect(f.database().run).toEqual(result.value)
})

it('cancels account preparation at the Start deadline without accepting late work', async () => {
  vi.useFakeTimers()
  const f = startSqlFixture()
  let signal: AbortSignal | undefined
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const accounts = {
    async prepare(_configuration: unknown, _selection: unknown, options?: { signal?: AbortSignal }) {
      signal = options?.signal
      await pending
      signal?.throwIfAborted()
      return undefined
    },
    async acceptMany() { return new Map() },
  } as unknown as AcceptedProviderAccountBindings
  const started = admitRepeatRun(f.pool, f.locations, f.principal, 'mcp', f.request,
    { ...f.publication, accountBindings: accounts })
  const rejected = expect(started).rejects.toMatchObject({ code: 'RUN_START_PREPARATION_TIMEOUT' })
  try {
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    expect(signal?.aborted).toBe(true)
    expect(f.database().run).toBeUndefined()
  } finally { release() }
})

it('forwards preparation cancellation to the provider resolver', async () => {
  const f = startSqlFixture()
  const signal = new AbortController().signal
  let received: AbortSignal | undefined
  const accounts = new AcceptedProviderAccountBindings({ resolve: async (_provider, _id, options) => {
    received = options?.signal
    throw new Error('Resolver reached')
  } })
  const harness = f.configurations[0]!.record.harness
  if (harness.harness !== 'codex') throw new Error('Expected a Codex configuration')
  await expect(accounts.prepare({ ...harness, accountId: 'account' }, undefined,
    { signal })).rejects.toThrow('Resolver reached')
  expect(received).toBe(signal)
})

it('releases the preparation connection before validating the workspace directory', async () => {
  const f = startSqlFixture()
  singleConnection(f)
  const snapshot = f.locations.snapshot.bind(f.locations)
  let checked = false
  f.locations.snapshot = async (...args) => {
    const client = await f.pool.connect()
    try { checked = true } finally { client.release() }
    return snapshot(...args)
  }
  const result = await admitRepeatRun(f.pool, f.locations, f.principal, 'mcp', f.request, f.publication)
  expect(checked).toBe(true)
  expect(f.database().run).toEqual(result.value)
})
