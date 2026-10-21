import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createWorkerJobInputPort as originalInputFactory } from '../src/modules/files/jobInputs/factory.js'
import { createWorkerJobInputPort } from '../src/modules/files/jobInputs/workerFactory.js'
import { createWorkerJobOutputCollector as originalOutputCollector, createRemoteJobOutputCollector as originalRemoteCollector } from '../src/modules/runs/remote/jobCanonicalOutputs.js'
import { createWorkerJobOutputCollector, createRemoteJobOutputCollector } from '../src/modules/runs/remote/workerJobOutputs.js'
import { JOB_OUTPUT_NAMESPACE as originalNamespace, outputTransferContext as originalContext } from '../src/modules/files/jobs/outputAdmission.js'
import { JOB_OUTPUT_NAMESPACE, outputTransferContext } from '../src/modules/files/jobs/workerProtocol.js'
import { JOB_INPUT_NAMESPACE as originalInputNamespace } from '../src/modules/files/jobInputs/service.js'
import { JOB_INPUT_NAMESPACE } from '../src/modules/files/jobInputs/protocol.js'
import { inputHash } from '../src/modules/files/jobInputs/manifest.js'
import { commandInputHash } from '../src/modules/commands/postgres.js'
import { transferContextForBinding } from '../src/modules/byte-transfer/carrier.js'
import { randomUUID } from 'node:crypto'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const workerRequire = createRequire(new URL('../../worker/package.json', import.meta.url))
const { build } = workerRequire('esbuild') as {
  build(options: Record<string, unknown>): Promise<{ metafile: { inputs: Record<string, unknown> } }>
}
const { assertWorkerDependency } = workerRequire(fileURLToPath(new URL('../../../scripts/worker-artifact-files.mjs', import.meta.url))) as {
  assertWorkerDependency(path: string): void
}

describe('SQL-free worker Job input/output leaves', () => {
  it('keeps Main compatibility exports and original identities unchanged', () => {
    expect(originalInputFactory).toBe(createWorkerJobInputPort)
    expect(originalOutputCollector).toBe(createWorkerJobOutputCollector)
    expect(originalRemoteCollector).toBe(createRemoteJobOutputCollector)
    expect(originalContext).toBe(outputTransferContext)
    expect(originalNamespace).toBe(JOB_OUTPUT_NAMESPACE)
    expect(originalInputNamespace).toBe(JOB_INPUT_NAMESPACE)
    expect(JOB_INPUT_NAMESPACE).toBe('job-inputs-v1')
    expect(JOB_OUTPUT_NAMESPACE).toBe('byte-transfer-v1')
    const binding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
      keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 7 }
    expect(outputTransferContext(binding)).toEqual(transferContextForBinding(binding))
    expect(outputTransferContext(binding).connectionEpoch).toBe(binding.connectionEpoch)
    for (const value of [null, { b: 2, a: 1 }, ['exact', { nested: true }]]) {
      expect(inputHash(value)).toBe(commandInputHash(value).slice(7))
    }
  })
  it('bundles both genuine worker factories with the unchanged production dependency guard and no Main SQL module', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../../packages/contracts/package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, string | { import: string }>
    }
    const aliases = Object.fromEntries(Object.entries(manifest.exports).map(([key, value]) => [
      key === '.' ? '@foreman-code/contracts' : `@foreman-code/contracts/${key.slice(2)}`,
      `./packages/contracts/${(typeof value === 'string' ? value : value.import).replace('./dist/', './src/').replace(/\.js$/, '.ts')}`,
    ]))
    const bundle = await build({ absWorkingDir: root,
      entryPoints: ['apps/api/src/modules/files/jobInputs/workerFactory.ts', 'apps/api/src/modules/runs/remote/workerJobOutputs.ts'],
      outdir: 'unused-worker-leaf-output', write: false, bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true,
      alias: aliases, plugins: [{ name: 'existing-worker-dependency-policy', setup(builder: {
        onResolve(options: { filter: RegExp }, callback: (input: { path: string }) => void): void
      }) { builder.onResolve({ filter: /.*/ }, input => { assertWorkerDependency(input.path) }) } }] })
    const modules = Object.keys(bundle.metafile.inputs)
    expect(modules).toContain('apps/api/src/modules/files/jobInputs/workerFactory.ts')
    expect(modules).toContain('apps/api/src/modules/runs/remote/workerJobOutputs.ts')
    expect(modules).toContain('apps/api/src/modules/files/jobInputs/channel.ts')
    expect(modules).toContain('apps/api/src/modules/files/jobs/outputChannel.ts')
    expect(() => assertWorkerDependency('pg')).toThrow('Forbidden control-plane dependency')
    const forbidden = /(?:apps\/api\/src\/(?:infrastructure\/|commands\/postgres|jobs\/(?:authority|repository|dispatch|receiptProjection)|files\/(?:jobInputs\/(?:factory|service|authority)|jobs\/(?:factory|admittedFactory|port|outputAdmission|ledger))|runs\/remote\/(?:jobCanonicalOutputs|jobApplicationBridge))|node_modules\/(?:pg(?:-|\/)|fastify\/))/
    expect(modules.filter(path => forbidden.test(path))).toEqual([])
  })
})
