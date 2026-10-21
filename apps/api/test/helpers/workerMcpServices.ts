import type { AppMcpServices } from '../../src/mcp/app/types.js'
import type { PostgresAccessService } from '../../src/modules/access/postgres.js'
import type { AppInteractionService } from '../../src/modules/interactions/app.js'
import { join } from 'node:path'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { AgentReferenceService } from '../../src/modules/files/references/agentService.js'
import { PostgresAgentReferenceAuthorization } from '../../src/modules/files/references/agentAuthorization.js'
import { PostgresReferenceReadRepository } from '../../src/modules/files/references/agentProvenance.js'
import { PostgresFileRepository } from '../../src/modules/files/postgres.js'
import { readFileRetentionSnapshot } from '../../src/modules/files/retentionSnapshot.js'
import { FileByteStorage } from '../../src/modules/files/storage.js'
import type { Pool } from 'pg'
import { BugReportService } from '../../src/modules/bug-reports/service.js'
import { HostCiService } from '../../src/modules/ci-host/service.js'
import type { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { RunCiAuthority } from '../../src/modules/jobs/ciAuthority.js'

/** Real domain services for every enabled Agent tool; external CI dispatch remains unavailable. */
export function workerToolServices(pool: Pool, commands: PostgresCommandCoordinator) {
  const bugReports = new BugReportService(pool, commands)
  const ci = new HostCiService(pool, commands, new RunCiAuthority(pool), {
    capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
    resolve: async () => { throw new Error('This fixture does not publish CI commits.') },
  }, {
    computers: async () => [],
    request: async () => { throw new Error('This fixture does not dispatch CI jobs.') },
  })
  const root = process.env.FOREMAN_CODE_TEST_ROOT
  if (!root) throw new Error('Worker reference services require owned test storage.')
  const references = new AgentReferenceService({
    files: new PostgresFileRepository(pool, readFileRetentionSnapshot),
    bytes: new FileByteStorage(join(root, 'worker-reference-files'), MAX_FILE_BYTES),
    authorization: new PostgresAgentReferenceAuthorization(pool), reads: new PostgresReferenceReadRepository(pool),
  })
  return { bugReports, ci, references,
    appMcp(access: PostgresAccessService, interactions: AppInteractionService): AppMcpServices {
      return { access, commands, interactions, bugReports, references }
    },
  }
}
