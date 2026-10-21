import { gzipSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import { CiRunOutputSchema, integrationPartition, type CiHostRequest } from '@foreman-code/contracts'
import { expandIntegrationCoverage } from '@foreman-code/contracts/ci-coverage'
import { gunzipSync } from 'node:zlib'
import { selectAffectedFiles } from '../../../scripts/ci-affected.mjs'
import { IntegrationCoverageStore } from '../src/modules/ci-host/coverageStore.js'
import type { CiMirrorInput } from '../src/modules/ci-host/serviceTypes.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

afterEach(() => { vi.restoreAllMocks() })
type Start = Extract<CiHostRequest, { operation: 'start' }>

it('persists one coverage input for publication, every sibling and a setup retry', async () => {
  const source = 'apps/api/src/feature.ts'
  const files = ['a', 'b', 'c'].map(name => `apps/api/test/${name}.integration.test.ts`)
  const payload = (includeFirst: boolean) => ({ changedFiles: [source], map: gzipSync(JSON.stringify({
    version: 1, commit: 'a'.repeat(40), testFiles: files,
    coverage: Object.fromEntries(files.map((file, index) => [file, includeFirst || index ? [source] : []])),
  })).toString('base64') })
  const first = payload(true)
  const later = payload(false)
  const lookup = vi.spyOn(IntegrationCoverageStore.prototype, 'selection')
    .mockResolvedValueOnce(first).mockResolvedValue(later)
  const published: CiMirrorInput[] = []
  const f = await fixture({ integrationInventory: { files,
    durations: Object.fromEntries(files.map(file => [file, 120_000])) }, cloud: { github: 2, circleci: 0 },
  publishMirror: async input => { published.push(input) } })
  f.computers.splice(0, f.computers.length, ...f.computers.filter(computer => computer.hostRef.kind === 'cloud'))
  try {
    const admitted = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', {
      suite: 'integration', scope: 'affected', partitions: 2, commit: 'b'.repeat(40), commandId: 'coverage-group',
    }))
    const initial = await f.waitFor(f.operator, admitted.ticketId,
      output => output.partitions?.length === 2 && output.partitions.every(run => run.state === 'running'))
    const originals = f.started.map(item => item.request).filter((request): request is Start =>
      request.operation === 'start' && request.suite === 'integration')
    expect(originals).toHaveLength(2)
    for (const request of originals) expect(request.integrationCoverage).toEqual(first)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(published).toHaveLength(1)
    expect(published[0]?.integrationCoverage).toEqual(first)
    const selected = (request: Start) => {
      const input = request.integrationCoverage!
      const coverageMap = expandIntegrationCoverage(JSON.parse(gunzipSync(Buffer.from(input.map!, 'base64')).toString()))
      const sources = new Map([[source, 'export const value = 1'],
        ...files.map(file => [file, "import '../src/feature.js'"] as [string, string])])
      const selection = selectAffectedFiles({ suite: 'integration', sources, changedFiles: input.changedFiles, coverageMap })
      return integrationPartition(selection.files, request.durations ?? {}, request.partition!)
    }
    expect(originals.flatMap(selected).sort()).toEqual(files)
    const failed = initial.partitions![0]!
    const completed = initial.partitions![1]!
    const endpoint = f.endpoint.request.bind(f.endpoint)
    f.endpoint.request = async (computer, request) => {
      const reply = await endpoint(computer, request)
      if (reply.operation === 'read' && request.operation === 'read'
        && request.runId === failed.id && reply.run.state === 'failed') {
        return { ...reply, run: { ...reply.run, testsStarted: false } }
      }
      return reply
    }
    f.finish(failed.id, 1, 'Setup failed.\n')
    f.finish(completed.id, 0, 'Completed.\n')
    await f.ci.dispatch()
    await f.ci.drain()
    const retried = await f.waitFor(f.operator, failed.id,
      output => output.run.state === 'running' && output.run.setupRetry !== undefined)
    const retry = f.started.map(item => item.request).find((request): request is Start =>
      request.operation === 'start' && request.runId === retried.run.setupRetry!.runId)!
    expect(retry.integrationCoverage).toEqual(first)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(originals.flatMap(request => selected(request.runId === failed.id ? retry : request)).sort()).toEqual(files)
    const saved = await f.pool.query<{ integration_selection: unknown }>(
      'select integration_selection from ci_runs where group_id=$1 and integration_selection is not null',
      [initial.run.groupId])
    expect(saved.rows).toEqual([{ integration_selection: first }])
  } finally { await f.close() }
})
