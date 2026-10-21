import type { CodexSessionDependencies } from './codexAppServer.js'
import { qualifyCodex, assertCodexUnchanged } from './codexProtocol.js'
import { qualifyNativeCodexModel } from './codexQualification.js'
import { runCommand } from './process.js'
import type { HarnessQualificationRepository } from './qualification/repository.js'
import { HarnessQualificationRegistry } from './qualification/registry.js'
import { runWithReadOnlyQualification } from './qualification/gate.js'

/** Preserve real native operations and their caller's original diagnostic/process owner.
 * Each operation first re-reads B's validated current installation and authenticated Main facts. */
export function createInstalledCodexDependencies(input: {
  reader: { capture(): Promise<unknown>; repository: Pick<HarnessQualificationRepository, 'find' | 'list'> }
  codexSuiteRevision: string
}) {
  const registry = new HarnessQualificationRegistry(input.reader.repository, { codex: input.codexSuiteRevision })
  const scoped = async <T>(work: () => Promise<T>): Promise<T> => {
    await input.reader.capture()
    const result = await runWithReadOnlyQualification(registry, work)
    await input.reader.capture()
    return result
  }
  return { mode: 'native',
    qualify: (...args) => scoped(() => qualifyCodex(...args)),
    assertUnchanged: (...args) => scoped(() => assertCodexUnchanged(...args)),
    runCommand: (...args) => scoped(() => runCommand(...args)),
    qualifyModel: (...args) => scoped(() => qualifyNativeCodexModel(...args)),
  } satisfies Extract<CodexSessionDependencies, { mode: 'native' }>
}
