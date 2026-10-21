import { RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import type { RecordedAgentHarness, OperatorConfigurationVersion } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'

/** An exact provider version is necessary, but is not a production/parity approval. */
export class NativeRollout {
  constructor(private readonly environment: NodeJS.ProcessEnv) {}
  enabled(harness: RecordedAgentHarness): boolean {
    if (harness === 'opencode') return false
    const selected = harness === 'codex'
      ? readProductEnvironment(this.environment, 'ENABLE_EXPERIMENTAL_CODEX_APP_SERVER')
      : readProductEnvironment(this.environment, 'ENABLE_EXPERIMENTAL_CLAUDE_SDK')
    const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(this.environment.HOST ?? '127.0.0.1')
    if (this.environment.NODE_ENV === 'production') {
      if (readProductEnvironment(this.environment, 'LOCAL_PRODUCTION') !== '1') return false
      try {
        const database = new URL(this.environment.DATABASE_URL ?? '')
        const localDatabase = ['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)
        if (!local || !localDatabase) return false
      } catch {
        return false
      }
    }
    // Supported local harnesses still pass native version, account, model,
    // approval and sandbox qualification at every execution admission.
    return selected === '1' || (selected === undefined && local)
  }
  assertChat(configuration: OperatorConfigurationVersion): void {
    const harness = configuration.harness.harness
    if (harness === 'opencode') throw new DomainError('HARNESS_RETIRED',
      RETIRED_OPENCODE_MESSAGE, 409)
    if (!this.enabled(harness)) throw new DomainError('OPERATOR_NATIVE_CAPABILITY_DISABLED',
      harness === 'codex'
        ? 'Codex execution is disabled for this runtime. Supported local installations enable it by default; native qualification remains required.'
        : 'Claude execution is disabled for this runtime. Supported local installations enable it by default; host native qualification remains required.', 409)
  }
}
