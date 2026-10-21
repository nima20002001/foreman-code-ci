import { describe, expect, it, vi } from 'vitest'
import { ScopedMcpDetectionSchema } from '@foreman-code/contracts'

import {
  McpDetectionService,
  WorkerLaunchCredentialService,
  intersectNativeToolFilters,
  type NativeMcpInspectionEvidence,
  type NativeMcpInspector,
} from '../src/modules/harnesses/mcpDetection.js'

const base: NativeMcpInspectionEvidence = {
  harness: 'codex', providerVersion: '0.154.0', runnerId: 'runner-a',
  workingDirectory: '/workspace', inspectedAt: '2026-09-16T00:00:00.000Z',
}

function service(evidence: NativeMcpInspectionEvidence | Error) {
  const inspector: NativeMcpInspector = {
    inspect: async () => { if (evidence instanceof Error) throw evidence; return evidence },
  }
  return new McpDetectionService(inspector, 'http://127.0.0.1:3000/mcp')
}

async function state(entry: NativeMcpInspectionEvidence['entry'], harness: 'codex' = 'codex') {
  return (await service({ ...base, harness, providerVersion: harness === 'codex' ? '0.154.0' : '1.18.31', ...(entry ? { entry } : {}) }).inspect({
    harness, runnerId: 'runner-a', workingDirectory: '/workspace',
  })).detection.state
}

describe('App MCP detection normalization', () => {
  const matching = {
    name: 'graphql', transport: 'streamable-http' as const,
    endpoint: 'http://127.0.0.1:3000/mcp',
    credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN',
  }
  it.each(['codex'] as const)('accepts old and canonical %s names and token references without changing tool filters', async (harness) => {
    for (const name of ['graphql', 'foreman-code']) {
      for (const credentialEnvironmentVariable of ['GRAPHQL_MCP_TOKEN', 'FOREMAN_CODE_MCP_TOKEN']) {
        const evidence = { ...base, harness, entry: { ...matching, name, credentialEnvironmentVariable,
          disabledTools: ['interaction_respond'] } }
        const detection = await service(evidence).preflight({ harness, runnerId: 'runner-a', workingDirectory: '/workspace' })
        expect(detection.detection).toMatchObject({ serverName: name, state: 'status_unavailable', credentialEnvironmentVariable })
        expect(intersectNativeToolFilters(['context_get', 'interaction_respond'], detection.nativeFilters)).toEqual(['context_get'])
      }
    }
  })

  it('accepts only proven app launchers with the shared credential and preserves disabled state', async () => {
    const launcher = { name: 'graphql', transport: 'stdio' as const, automaticEndpoint: true,
      credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN' }
    for (const harness of ['codex'] as const) {
      expect(await state(launcher, harness)).toBe('status_unavailable')
      expect(await state({ ...launcher, enabled: false }, harness)).toBe('disabled')
      expect(await state({ ...launcher, automaticEndpoint: false }, harness)).toBe('misconfigured')
      expect(await state({ ...launcher, credentialEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN' }, harness)).toBe('misconfigured')
      expect(await state({ ...launcher, name: 'graphql-app' }, harness)).toBe('misconfigured')
    }
  })

  it('covers every honest normalized state without treating inspection failure as absence', async () => {
    for (const harness of ['codex'] as const) {
      expect(await state(undefined, harness)).toBe('not_detected')
      expect(await state({ ...matching, endpoint: 'http://127.0.0.1:9999/mcp' }, harness)).toBe('misconfigured')
      expect(await state(matching, harness)).toBe('status_unavailable')
      expect(await state({ ...matching, status: 'connected' }, harness)).toBe('connected')
      expect(await state({ ...matching, status: 'disabled' }, harness)).toBe('disabled')
      expect(await state({ ...matching, status: 'authentication_required' }, harness)).toBe('authentication_required')
      expect(await state({ ...matching, status: 'broken' }, harness)).toBe('broken')
    }
    const failed = await service(new Error('unsupported output')).inspect({
      harness: 'codex', runnerId: 'runner-a', workingDirectory: '/workspace',
    })
    expect(failed.detection).toMatchObject({ state: 'check_failed', endpointMatches: null })
    expect(failed.detection.detail).not.toContain('unsupported output')
    expect(failed.detection.detail).toContain('inspection')
    expect(ScopedMcpDetectionSchema.parse(failed)).toEqual(failed)
  })

  it('requires exact endpoint, transport, and credential reference before preflight succeeds', async () => {
    await expect(service({ ...base, entry: { ...matching, credentialEnvironmentVariable: 'OTHER' } }).preflight({
      harness: 'codex', runnerId: 'runner-a', workingDirectory: '/workspace',
    })).rejects.toMatchObject({ code: 'APP_MCP_PREFLIGHT_FAILED' })
    await expect(service({ ...base, entry: matching }).preflight({
      harness: 'codex', runnerId: 'runner-a', workingDirectory: '/workspace',
    })).resolves.toMatchObject({ detection: { state: 'status_unavailable' } })
  })

  it('applies native filters only as a narrowing intersection', () => {
    expect(intersectNativeToolFilters(
      ['context_get', 'interaction_list', 'interaction_get'],
      { enabledTools: ['context_get', 'interaction_respond'], disabledTools: ['interaction_get'] },
    )).toEqual(['context_get'])
  })

  it('does not issue a credential until preflight succeeds', async () => {
    let issued = 0
    const credentials = {
      ttlMs: 15 * 60 * 1000,
      issueForExecution: async () => { issued += 1; throw new Error('must not issue') },
      revoke: async () => undefined,
    }
    const launch = new WorkerLaunchCredentialService(
      service({ ...base, entry: { ...matching, endpoint: 'http://127.0.0.1:9999/mcp' } }),
      credentials as never,
      'runner-a',
    )
    await expect(launch.prepare({
      executionId: 'execution-a', harness: 'codex', workingDirectory: '/workspace',
    })).rejects.toMatchObject({ code: 'APP_MCP_PREFLIGHT_FAILED' })
    expect(issued).toBe(0)
  })

  it('reports an inspection deadline distinctly from configuration failure', async () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      const detection = new McpDetectionService({ inspect: async input => {
        signal = input.signal
        return new Promise(() => {})
      } }, 'http://127.0.0.1:3000/mcp', 'foreman-code', 50)
      const pending = detection.preflight({ harness: 'codex', runnerId: 'runner-a', workingDirectory: '/workspace' })
      const assertion = expect(pending).rejects.toMatchObject({ code: 'APP_MCP_PREFLIGHT_TIMEOUT',
        details: { inspectionCodes: ['NATIVE_MCP_INSPECTION_TIMEOUT'] } })
      await vi.advanceTimersByTimeAsync(50)
      await assertion
      expect(signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports native command timeouts without exposing provider errors', async () => {
    const detection = service(new DOMException('private provider output', 'TimeoutError'))
    const result = await detection.inspect({ harness: 'codex', runnerId: 'runner-a', workingDirectory: '/workspace' })
    expect(result.nativeFilters.diagnostics).toEqual(['NATIVE_MCP_INSPECTION_TIMEOUT'])
    expect(result.detection.detail).toContain('timed out')
    expect(result.detection.detail).not.toContain('private provider output')
    await expect(detection.preflight({ harness: 'codex', runnerId: 'runner-a', workingDirectory: '/workspace' }))
      .rejects.toMatchObject({ code: 'APP_MCP_PREFLIGHT_TIMEOUT' })
  })

  it('preserves caller cancellation instead of reporting a preflight failure', async () => {
    const controller = new AbortController()
    const reason = new Error('caller canceled')
    const detection = new McpDetectionService({ inspect: async () => {
      controller.abort(reason)
      return new Promise(() => {})
    } }, 'http://127.0.0.1:3000/mcp')
    await expect(detection.preflight({ harness: 'codex', runnerId: 'runner-a', workingDirectory: '/workspace',
      signal: controller.signal })).rejects.toBe(reason)
  })

  it('does not issue a credential when configuration inspection times out', async () => {
    const issueForExecution = vi.fn()
    const credentials = { ttlMs: 15 * 60 * 1000, issueForExecution, revoke: async () => undefined }
    const launch = new WorkerLaunchCredentialService(
      service(new DOMException('private provider output', 'TimeoutError')),
      credentials as never,
      'runner-a',
    )
    await expect(launch.prepare({
      executionId: 'execution-a', harness: 'codex', workingDirectory: '/workspace',
    })).rejects.toMatchObject({ code: 'APP_MCP_PREFLIGHT_TIMEOUT' })
    expect(issueForExecution).not.toHaveBeenCalled()
  })
})
