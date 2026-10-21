import { describe, expect, it } from 'vitest'
import { currentGraphPrincipal, currentGraphReadUnit } from './helpers/currentGraphReadUnit.js'

// Current V3 canonical read, not the removed V1 liveSnapshot SQL. The actual
// primary transaction, immutable readers, projection and permanent-receipt
// verification run on a strict SQL-shaped model. This is not a scale benchmark.
describe('FE-R2-001 current canonical read (SQL model, not a database scale test)', () => {
  it('uses one coherent read transaction and never loads historical bodies or unbounded activity', async () => {
    const f = await currentGraphReadUnit()
    const value = await f.canonical.current(f.principal, f.request)
    expect(value.kind).toBe('current')
    expect(value.scope).toEqual(f.request.scope)
    expect(f.db.transactions).toEqual([{ readOnly: true, isolation: 'repeatable read', outcome: 'committed' }])
    expect(f.db.historyBodyReads).toBe(0)
    expect(value).not.toHaveProperty('activity')
    expect(value).not.toHaveProperty('liveActivity')
    expect(value.state.executions).toEqual([]); expect(value.state.occurrences).toEqual([])
  })
  it.each([false, true])('keeps completed outcome separate from cleanup=%s without inferring physical closure', async (cleanupPending) => {
    const f = await currentGraphReadUnit()
    await f.db.changeRun({ executionState: 'completed', outcome: 'succeeded', cleanupPending })
    const result = await f.canonical.current(f.principal, f.request)
    expect(result.state.run).toMatchObject({ executionState: 'completed', outcome: 'succeeded', cleanupPending })
    expect(result.state.run).not.toHaveProperty('processStopped')
    expect(result.state.run).not.toHaveProperty('nativeAcknowledged')
  })
  it('rejects retired, missing, string and unknown request semantics before SQL rather than normalizing', async () => {
    const f = await currentGraphReadUnit()
    for (const executionSemanticsVersion of [1, 2, 4, '3', null, undefined]) {
      await expect(Promise.resolve().then(() => f.canonical.current(f.principal,
        { ...f.request, scope: { ...f.request.scope, executionSemanticsVersion } })))
        .rejects.toMatchObject({ code: 'GRAPH_SCOPE_MISMATCH' })
    }
    expect(f.db.calls).toEqual([])
  })
  it('rejects conflicting physical, version and definition semantics without substituting another reader', async () => {
    for (const layer of ['physical', 'version', 'definition'] as const) {
      const f = await currentGraphReadUnit()
      if (layer === 'physical') f.db.scope.executionSemanticsVersion = 2
      else if (layer === 'version') Object.assign(f.db.fixture.version, { executionSemanticsVersion: 2 })
      else Object.assign(f.db.fixture.version.definition, { executionSemanticsVersion: 2 })
      await expect(f.canonical.current(f.principal, f.request)).rejects.toMatchObject({
        code: layer === 'physical' ? 'GRAPH_SCOPE_MISMATCH' : 'GRAPH_INVARIANT_VIOLATION',
      })
      expect(f.db.transactions.at(-1)?.outcome).toBe('rolled-back')
      expect(f.db.historyBodyReads).toBe(0)
    }
  })
  it('rejects inconsistent persisted identity, definition, duplicate nodes and changed configuration pins', async () => {
    const changes: Array<(f: Awaited<ReturnType<typeof currentGraphReadUnit>>) => void> = [
      (f) => { f.db.fixture.version.id = 'wrong-version' },
      (f) => { f.db.fixture.version.definition.id = 'wrong-workflow' },
      (f) => { f.db.fixture.run.workspaceId = 'wrong-workspace' },
      (f) => { f.db.fixture.version.definition.nodes.push({ ...f.db.fixture.version.definition.nodes[0]! }) },
      (f) => { f.db.fixture.configurations[0]!.agentId = 'wrong-agent' },
      (f) => { f.db.fixture.version.contentHash = `sha256:${'f'.repeat(64)}` },
    ]
    for (const change of changes) {
      const f = await currentGraphReadUnit(); change(f)
      const before = structuredClone(f.db.state)
      await expect(f.canonical.current(f.principal, f.request)).rejects.toMatchObject({ code: 'GRAPH_INVARIANT_VIOLATION' })
      expect(f.db.transactions.at(-1)?.outcome).toBe('rolled-back')
      expect(f.db.state).toEqual(before)
    }
  })
  it('authorizes before protected metadata reads using runs:read without location privilege', async () => {
    const f = await currentGraphReadUnit()
    await expect(f.canonical.current(currentGraphPrincipal(false), f.request)).rejects.toMatchObject({ code: 'GRAPH_READ_ACCESS_DENIED' })
    expect(f.db.calls).toEqual([])
    const foreign = currentGraphPrincipal()
    foreign.grants[0]!.scope.workflowIds = ['foreign']
    await expect(f.canonical.current(foreign, f.request)).rejects.toMatchObject({ code: 'GRAPH_READ_ACCESS_DENIED' })
    expect(f.db.protectedMetadataReads).toBe(0)
    expect(f.db.transactions.at(-1)?.outcome).toBe('rolled-back')
    const result = await f.canonical.current(f.principal, f.request)
    const wire = JSON.stringify(result)
    expect(wire).not.toMatch(/PRIVATE-RUN-INPUT|executionLocation|authorizationPrincipalId|workingDirectory|runtimeDirectory|nativeSessionId|"prompt"/)
  })
  it('rejects a public projection whose committed source digest no longer matches', async () => {
    const f = await currentGraphReadUnit()
    const source = f.db.state.sources.find(row => row.source_digest === f.db.state.projection!.source_digest)!
    source.source_digest = `sha256:${'f'.repeat(64)}`
    await expect(f.canonical.current(f.principal, f.request)).rejects.toMatchObject({ code: 'GRAPH_INVARIANT_VIOLATION' })
    expect(f.db.transactions.at(-1)?.outcome).toBe('rolled-back')
  })
  it('does not fall back to full details on missing head or an exact scope miss', async () => {
    const f = await currentGraphReadUnit(); f.db.initialized = false
    await expect(f.canonical.current(f.principal, f.request)).rejects.toMatchObject({ code: 'GRAPH_NOT_INITIALIZED' })
    expect(f.db.historyBodyReads).toBe(0)
    expect(f.db.initialized).toBe(false)
    f.db.initialized = true; f.db.calls.length = 0
    await expect(f.canonical.current(f.principal, { ...f.request, scope: { ...f.request.scope, workflowVersionId: 'foreign-version' } }))
      .rejects.toMatchObject({ code: 'GRAPH_SCOPE_MISMATCH' })
    expect(f.db.protectedMetadataReads).toBe(0)
    expect(f.db.historyBodyReads).toBe(0)
  })
})
