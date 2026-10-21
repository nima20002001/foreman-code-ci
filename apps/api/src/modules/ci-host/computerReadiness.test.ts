import type pg from 'pg'
import Fastify from 'fastify'
import { afterEach, expect, it, vi } from 'vitest'
import { CiComputersOutputSchema, type CiHostStatus } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { registerGraphqlMcp } from '../../mcp/unified/transport.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { PostgresAccessService } from '../access/postgres.js'
import { requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DeviceApplicationAdmissionError, DeviceApplicationError } from '../devices/deviceApplicationError.js'
import { CI_GET_ACTIONS, type CiAuthority } from '../jobs/ciAuthority.js'
import { HostCiService, type CiCommits, type HostCiEndpoint } from './service.js'

afterEach(() => { vi.restoreAllMocks() })

function fixture() {
  let now = Date.parse('2026-01-01T00:00:00Z')
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const workspaceId = 'fixture-workspace'
  const caller: ManagementPrincipal = { id: 'fixture-reader', name: 'Fixture reader', audience: 'operator',
    grants: [{ actions: CI_GET_ACTIONS, scope: { workspaceIds: [workspaceId] } }],
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null }
  const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool
  const computer = { key: 'fixture-main:fixture-worker', label: 'Fixture Worker', priority: 50,
    buildAllowancePercent: 75,
    hostRef: { kind: 'device' as const, mainId: 'fixture-main', deviceId: 'fixture-worker' } }
  const status: CiHostStatus = { operation: 'status', ready: true, reasons: [], cpuCount: 6,
    memoryBytes: 12 * 2 ** 30, availableMemoryBytes: 8 * 2 ** 30, buildAllowancePercent: 75,
    startProtocolVersion: 3, slotsTotal: 2, slotsUsed: 1, runs: [] }
  const request = vi.fn<HostCiEndpoint['request']>().mockResolvedValue(status)
  const computers = vi.fn<HostCiEndpoint['computers']>().mockResolvedValue([computer])
  const authority: CiAuthority = { resolve: async principal => {
    for (const action of CI_GET_ACTIONS) requireAuthorization(principal, action, { workspaceId })
    return { principal, workspaceId }
  } }
  const ci = new HostCiService(pool, {} as PostgresCommandCoordinator, authority, {} as CiCommits,
    { computers, request })
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token =>
    token === 'reader' ? caller : { ...caller, id: 'fixture-denied', grants: [] })
  const app = Fastify()
  registerGraphqlMcp(app, { access, operator: { ci,
    commands: { recordDenied: async () => undefined } } as unknown as OperatorServices })
  const call = async (token = 'reader') => {
    const response = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ci_computers_list',
        arguments: { workspaceId } } } })
    expect(response.statusCode).toBe(200)
    const data = response.body.split('\n').find(line => line.startsWith('data: '))
    return data ? JSON.parse(data.slice(6)) : response.json()
  }
  return { request, computers, computer, status, call,
    list: async () => CiComputersOutputSchema.parse(decodeMcpToolResult((await call()).result)),
    expire: () => { now += 6000 },
    close: async () => { await ci.close(); await app.close() } }
}

it.each([true, false])('retains last known readiness=%s when background status reads yield', async ready => {
  const f = fixture()
  f.status.ready = ready
  f.status.reasons = ready ? [] : ['GitHub login required']
  try {
    const first = await f.list()
    expect(first.computers[0]).toMatchObject({ ready, reasons: f.status.reasons, allowedCpuCount: 6,
      memoryBytes: f.status.memoryBytes, availableMemoryBytes: f.status.availableMemoryBytes,
      buildAllowancePercent: 75, slotsTotal: 2, slotsUsed: 1 })
    f.expire()
    f.request.mockRejectedValue(new DeviceApplicationAdmissionError('background_yield'))
    expect(await f.list()).toEqual(first)
    expect(await f.list()).toEqual(first)
    expect(f.request).toHaveBeenCalledTimes(3)
    f.request.mockResolvedValue({ ...f.status, ready: !ready, reasons: ['Updated status'], slotsUsed: 0 })
    expect((await f.list()).computers[0]).toMatchObject({ ready: !ready, reasons: ['Updated status'], slotsUsed: 0 })
    expect(f.request).toHaveBeenCalledTimes(4)
    const denied = await f.call('denied')
    expect(denied.result?.isError ?? Boolean(denied.error)).toBe(true)
    expect(f.request).toHaveBeenCalledTimes(4)
  } finally {
    await f.close()
  }
})

it.each(['transport', 'permission', 'backpressure'])(
  'invalidates last known readiness after a %s application failure', async code => {
    const f = fixture()
    try {
      await f.list()
      f.expire()
      f.request.mockRejectedValue(new DeviceApplicationError(code))
      expect((await f.list()).computers[0]).toMatchObject({ ready: false, reasons: [code] })
      f.request.mockRejectedValue(new DeviceApplicationAdmissionError('background_yield'))
      expect((await f.list()).computers[0]).toMatchObject({ ready: false, reasons: ['backpressure'] })
    } finally {
      await f.close()
    }
  },
)

it.each([true, false])('retries yielded reads without renewing readiness=%s freshness', async ready => {
  const f = fixture()
  f.status.ready = ready
  try {
    const first = await f.list()
    f.expire()
    f.request.mockRejectedValue(new DeviceApplicationAdmissionError('background_yield'))
    expect(await f.list()).toEqual(first)
    f.request.mockResolvedValue({ ...f.status, ready: !ready, reasons: ['Refreshed status'] })
    expect((await f.list()).computers[0]).toMatchObject({ ready: !ready, reasons: ['Refreshed status'] })
    expect(f.request).toHaveBeenCalledTimes(3)
  } finally {
    await f.close()
  }
})

it('does not invent readiness without a successful status read', async () => {
  const f = fixture()
  try {
    f.request.mockRejectedValue(new DeviceApplicationAdmissionError('background_yield'))
    expect((await f.list()).computers[0]).toMatchObject({ ready: false, reasons: ['backpressure'] })
  } finally {
    await f.close()
  }
})

it('does not reuse status after the computer leaves the fleet or its allowance changes', async () => {
  const f = fixture()
  try {
    await f.list()
    f.computers.mockResolvedValue([])
    expect((await f.list()).computers).toEqual([])
    f.computers.mockResolvedValue([f.computer])
    f.request.mockRejectedValue(new DeviceApplicationAdmissionError('background_yield'))
    expect((await f.list()).computers[0]).toMatchObject({ ready: false })
    f.request.mockResolvedValue(f.status)
    await f.list()
    f.computers.mockResolvedValue([{ ...f.computer, buildAllowancePercent: 50 }])
    f.request.mockRejectedValue(new DeviceApplicationAdmissionError('background_yield'))
    expect((await f.list()).computers[0]).toMatchObject({ ready: false, buildAllowancePercent: 50 })
  } finally {
    await f.close()
  }
})
