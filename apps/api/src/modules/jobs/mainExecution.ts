import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { join } from 'node:path'
import type pg from 'pg'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import type { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import type { JobApplicationBridge } from '../runs/remote/jobApplicationBridge.js'
import { createInstalledJobSource } from '../runs/remote/installedJobSource.js'
import { createLocalJobCanonicalOutputs } from '../runs/remote/jobCanonicalOutputs.js'
import { readInstalledRootConfiguration } from '../sources/installedRootConfiguration.js'
import type { ReadonlyJobInputDelivery } from '../files/jobInputs/delivery.js'
import type { JobPublicationAuthority } from './authority.js'
import type { InstalledRuntimeConfigurationLocation } from './installedRuntimeHost.js'
import { createInstalledJobExecutionHost } from './executorInstalled.js'
import type { RemoteJobExecutionHost } from '../runs/remote/jobExecutionHost.js'

export interface MainJobExecutionDependencies {
  pool: pg.Pool
  mainId: string
  runtimeRoot: string
  storageRoot: string
  configuration: InstalledRuntimeConfigurationLocation
  registry: NativeProcessRegistry
  /** The same persisted journal used by approved Main qualification. */
  journal(): Promise<RemoteOperationJournal>
  application(): JobApplicationBridge
  inputs(): ReadonlyJobInputDelivery
  publication(): JobPublicationAuthority
}

/** Defers operational journal access until the installed Main Job lifecycle is used. */
export function createMainJobExecutionHost(input: MainJobExecutionDependencies): Pick<RemoteJobExecutionHost,
  'handle' | 'recover' | 'shutdown' | 'drain'> {
  const connection = { kind: 'main' as const, mainId: input.mainId,
    mainInstallationId: input.mainId, bootId: bootIdentity() }
  const incarnationId = randomUUID()
  let opening: Promise<RemoteJobExecutionHost> | undefined
  const open = () => opening ??= (async () => {
    const journal = await input.journal()
    const outputs = createLocalJobCanonicalOutputs({ pool: input.pool, storageRoot: input.storageRoot,
      authority: input.publication(), journal })
    const source = createInstalledJobSource({ journal,
      application: { resolveAcceptedSource: intent => input.application().resolveAcceptedSource(intent, connection) },
      currentBinding: () => connection,
      approvedRoots: () => readInstalledRootConfiguration(join(input.runtimeRoot, 'approved-roots.json')) })
    return createInstalledJobExecutionHost({ registry: input.registry, configuration: input.configuration,
      journal, connection, incarnationId, source, inputs: input.inputs(), collectOutputs: outputs.collectOutputs,
      async authorize(intent, execution, action) {
        if (execution.id !== intent.executionId || execution.operationId !== intent.operationId
          || execution.attemptId !== intent.attemptId || !isDeepStrictEqual(execution.owner, intent.owner)) {
          throw new Error('Installed Main Job authority differs from its accepted operation.')
        }
        await input.application().handle({ method: 'job-authorize', intent, action }, connection)
      },
      async observeReceipt(receipt) {
        await input.application().handle({ method: 'job-report', receipt }, connection)
      },
      async appendLog(chunk) {
        const owners = (await journal.jobOperations()).filter(receipt => receipt.execution.id === chunk.executionId
          && receipt.intent.attemptId === chunk.attemptId)
        if (owners.length !== 1) throw new Error('Original Main Job log owner is unavailable.')
        await input.application().handle({ method: 'job-log', intent: owners[0]!.intent, chunk }, connection)
      },
    })
  })()
  return {
    handle: async raw => (await open()).handle(raw),
    recover: async () => (await open()).recover(),
    shutdown: async () => { if (opening) await (await opening).shutdown() },
    drain: async () => { if (opening) await (await opening).drain() },
  }
}
