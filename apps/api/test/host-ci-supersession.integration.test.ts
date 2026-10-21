import { CiGetOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { DomainError } from '../src/modules/errors.js'
import { fixture } from './helpers/hostCiMcpFixture.js'
import { rejectableDeferred } from './helpers/deferred.js'
import { ciRunReadback } from './helpers/ciRunReadback.js'

it('supersedes every queued and running part through MCP and preserves the replacement across retries', async () => {
  const oldCommit = 'a'.repeat(40)
  const nextCommit = 'b'.repeat(40)
  const f = await fixture({ supersession: {
    branch: () => 'feature', isAncestor: (ancestor, commit) => ancestor === oldCommit && commit === nextCommit,
  } })
  f.computers.splice(1)
  const canceled: string[] = []
  const request = f.endpoint.request.bind(f.endpoint)
  f.endpoint.request = async (computer, input) => {
    const reply = await request(computer, input)
    if (input.operation === 'cancel') canceled.push(input.runId)
    return reply
  }
  try {
    const tools = await f.operator.listTools()
    expect(tools.tools.find(tool => tool.name === 'ci_run')?.annotations?.destructiveHint).toBe(true)
    const old = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'typecheck', commit: oldCommit, commandId: 'old-checks',
    }))
    const before = await f.waitFor(f.operator, old.ticketId, output =>
      output.partitions!.filter(run => run.state === 'running').length === 1
        && output.partitions!.some(run => run.observation?.status === 'available'))
    expect(before.partitions!.map(run => run.state).sort()).toEqual(['queued', 'running'])
    const input = { suite: 'typecheck', commit: nextCommit, commandId: 'replacement-checks' }
    const denied = await f.connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS], { workspaceIds: ['another-workspace'] })
    expect((await f.call(denied, 'ci_run', input)).isError).toBe(true)
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: old.ticketId })).partitions!)
      .toEqual(before.partitions!.map(run => run.state === 'running' ? { ...run,
        observation: { status: 'available', lastSuccessAt: expect.any(String), lastError: null,
          consecutiveFailures: 0, nextAttemptAt: null } } : run))
    const next = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    // Superseded executor cleanup runs in the background dispatch pass.
    await f.ci.drain()
    const read = await ciRunReadback(input => f.value(f.operator, 'ci_get', input), old.ticketId, 'canceled')
    expect(read.partitions).toHaveLength(2)
    for (const part of read.partitions!) {
      expect(part).toMatchObject({ state: 'canceled', supersededBy: next.ticketId,
        message: `superseded by ${next.ticketId}` })
      expect(part.finishedAt).not.toBeNull()
    }
    expect(canceled).toEqual([before.partitions!.find(run => run.state === 'running')!.id])
    expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(next)
    expect(canceled).toHaveLength(1)
    const persisted = (await f.pool.query<{ record: unknown; host_key: string | null }>(
      'select record,host_key from ci_runs where group_id=$1', [read.run.groupId])).rows
    expect(persisted.map(row => row.record)).toEqual(expect.arrayContaining(read.partitions!))
    expect(persisted.every(row => row.host_key === null)).toBe(true)
    expect((await f.pool.query(`select details from management_audit where action='ci.supersede'`)).rows)
      .toHaveLength(2)
    expect((await f.pool.query(`select outcome from management_audit where action='ci_run'`)).rows)
      .toContainEqual({ outcome: 'denied' })
    const replacement = await f.waitFor(f.operator, next.ticketId, output =>
      output.partitions!.some(run => run.state === 'running'))
    expect(replacement.partitions!.some(run => run.state === 'running')).toBe(true)
  } finally { await f.close() }
})

it('keeps main, explicit keep, unrelated branch, suite, requester and non-descendant tickets through MCP', async () => {
  const commits = ['a', 'b', 'c', 'd', 'e', 'f'].map(char => char.repeat(40))
  const f = await fixture({ supersession: {
    branch: commit => commit === commits[0] ? 'main' : commit === commits[2] ? 'other-feature' : 'feature',
    isAncestor: (ancestor, commit) => commit === '1'.repeat(40) && ancestor !== commits[4],
  } })
  f.computers.splice(0)
  try {
    const tickets: string[] = []
    for (const [index, commit] of commits.entries()) {
      tickets.push(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
        suite: index === 5 ? 'build' : 'typecheck', commit,
        noSupersede: index === 1, commandId: `protected-${index}`,
      })).ticketId)
    }
    const other = await f.connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
    // Another requester's own ticket on another commit; an identical request would join the group instead.
    const foreign = CiRunOutputSchema.parse(await f.value(other, 'ci_run', {
      suite: 'typecheck', commit: '9'.repeat(40), commandId: 'another-requester',
    }))
    const withoutCi = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(withoutCi, 'ci_run', {
      suite: 'typecheck', commit: '1'.repeat(40), commandId: 'missing-ci-grant',
    })).isError).toBe(true)
    const next = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'typecheck', commit: '1'.repeat(40), commandId: 'latest-checks',
    }))
    for (const [index, ticketId] of tickets.entries()) {
      const read = index === 3
        ? await ciRunReadback(input => f.value(f.operator, 'ci_get', input), ticketId, 'canceled')
        : CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId }))
      if (index === 3) {
        expect(read.run).toMatchObject({ state: 'canceled', supersededBy: next.ticketId })
      } else {
        expect(read.run.state).toBe('queued')
        expect(read.run.supersededBy).toBeUndefined()
      }
      if (index === 1) expect(read.run.noSupersede).toBe(true)
    }
    expect(CiGetOutputSchema.parse(await f.value(other, 'ci_get', { ticketId: foreign.ticketId })).run.state)
      .toBe('queued')
  } finally { await f.close() }
})

it('retries superseded running cleanup before releasing its computer slot', async () => {
  const f = await fixture({ supersession: { branch: () => 'feature', isAncestor: () => true } })
  f.computers.splice(1)
  const request = f.endpoint.request.bind(f.endpoint)
  const unavailableCancellation = rejectableDeferred<void>()
  const replacementStarted = rejectableDeferred<void>()
  let offline = false
  f.endpoint.request = async (computer, input) => {
    if (offline && input.operation === 'cancel') {
      unavailableCancellation.resolve()
      throw new DomainError('CI_COMPUTER_OFFLINE', 'Offline.', 409)
    }
    const reply = await request(computer, input)
    if (input.operation === 'start' && input.commit === 'b'.repeat(40)) replacementStarted.resolve()
    return reply
  }
  const read = async (ticketId: string) => {
    const result = await f.operator.callTool({ name: 'ci_get', arguments: { workspaceId: f.workspaceId, ticketId } })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return CiGetOutputSchema.parse(decodeMcpToolResult(result))
  }
  try {
    const old = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'install', commit: 'a'.repeat(40), commandId: 'cleanup-old',
    }))
    await f.waitFor(f.operator, old.ticketId, output => output.run.state === 'running')
    offline = true
    const next = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'install', commit: 'b'.repeat(40), commandId: 'cleanup-next',
    }))
    await unavailableCancellation.promise
    expect((await read(old.ticketId)).run)
      .toMatchObject({ state: 'running', supersededBy: next.ticketId })
    expect((await read(next.ticketId)).run.state)
      .toBe('queued')
    expect(f.started).toHaveLength(1)
    offline = false
    await replacementStarted.promise
    const canceled = await ciRunReadback(input => f.value(f.operator, 'ci_get', input), old.ticketId, 'canceled')
    expect(canceled.run)
      .toMatchObject({ state: 'canceled', message: `superseded by ${next.ticketId}` })
    expect((await f.waitFor(f.operator, next.ticketId, output => output.run.state === 'running')).run.state)
      .toBe('running')
  } finally { await f.close() }
})

it('supersedes detached Agent commits only within that execution while reading workspace tickets through MCP', async () => {
  const f = await fixture({ agent: true, supersession: { branch: () => null, isAncestor: () => true } })
  f.computers.splice(0)
  try {
    const call = async (input: Record<string, unknown>, client = f.agent!) => {
      const result = await client.callTool({ name: 'ci_run', arguments: input })
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      return CiRunOutputSchema.parse(decodeMcpToolResult(result))
    }
    const old = await call({ suite: 'install', commit: 'a'.repeat(40), commandId: 'agent-old' })
    // A separate Operator request on the same commit; an identical request would join the Agent's group instead.
    const operator = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'install', commit: 'a'.repeat(40), scope: 'full', commandId: 'operator-detached',
    }))
    const renewed = await f.connectAgent!()
    const next = await call({ suite: 'install', commit: 'b'.repeat(40), commandId: 'agent-next' }, renewed)
    const read = await ciRunReadback(input => f.value(f.agent!, 'ci_get', input), old.ticketId, 'canceled')
    expect(read.run)
      .toMatchObject({ state: 'canceled', supersededBy: next.ticketId })
    const replacement = await renewed.callTool({ name: 'ci_get', arguments: { ticketId: next.ticketId } })
    expect(CiGetOutputSchema.parse(decodeMcpToolResult(replacement)).run.initiator.principalId)
      .not.toBe(read.run.initiator.principalId)
    const operatorRead = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: operator.ticketId }))
    expect(operatorRead.run.state).toBe('queued')
    const workspaceRead = await f.agent!.callTool({ name: 'ci_get', arguments: { ticketId: operator.ticketId } })
    expect(workspaceRead.isError).not.toBe(true)
    expect(CiGetOutputSchema.parse(decodeMcpToolResult(workspaceRead))).toEqual(operatorRead)
  } finally { await f.close() }
})

it('resolves branches of existing tickets before superseding them and protects existing main work', async () => {
  const f = await fixture({ supersession: {
    branch: commit => commit === 'a'.repeat(40) ? 'main' : 'feature', isAncestor: () => true,
  } })
  f.computers.splice(0)
  try {
    const main = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'install', commit: 'a'.repeat(40), commandId: 'existing-main',
    }))
    const feature = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'install', commit: 'b'.repeat(40), commandId: 'existing-feature',
    }))
    await f.pool.query(`update ci_runs set record=record-'branch'-'defaultBranch' where id=any($1::uuid[])`,
      [[main.ticketId, feature.ticketId]])
    const next = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'install', commit: 'c'.repeat(40), commandId: 'supersede-existing',
    }))
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: main.ticketId })).run.state)
      .toBe('queued')
    const canceled = await ciRunReadback(input => f.value(f.operator, 'ci_get', input), feature.ticketId, 'canceled')
    expect(canceled.run)
      .toMatchObject({ state: 'canceled', supersededBy: next.ticketId })
  } finally { await f.close() }
})
