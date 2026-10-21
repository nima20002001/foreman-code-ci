import { CanonicalNativeArtifactResults } from './distributed/nativeResults.js'
import { DistributedArtifactPublicationService, type ArtifactPublicationAuthority, type VerifiedArtifactReader } from './distributed/publication.js'
import { PostgresDistributedPublicationLedger } from './distributed/publicationLedger.js'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'

import type { ApiConfig } from '../../config.js'
import { registerFileRoutes } from '../../routes/files.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { PostgresFileReferenceAuthorization } from './references/authorization.js'
import { registerFileReferenceRoutes } from '../../routes/fileReferences.js'
import { FileReferenceService } from './references/service.js'
import { PostgresAgentReferenceAuthorization } from './references/agentAuthorization.js'
import { PostgresReferenceReadRepository } from './references/agentProvenance.js'
import { AgentReferenceService } from './references/agentService.js'
import { workspaceStorageRoot } from '../workspaces/storage.js'
import { PostgresFileConversationAuthorization } from './authorization.js'
import { PostgresFileRepository } from './postgres.js'
import { TemporaryFileService } from './service.js'
import { readFileRetentionSnapshot } from './retentionSnapshot.js'
import { defaultFileStorageRoot, FileByteStorage } from './storage.js'
import { registerProductionFileTools } from './tools/production.js'
import { agentFileReferenceResolver } from './tools/referenceResolver.js'
import type { FileReferenceResolver } from './tools/types.js'
import { ManagedFileCleanupBytes } from './cleanup/bytes.js'
import { PostgresFileCleanupRepository } from './cleanup/postgres.js'
import { TemporaryFileCleanupSweeper } from './cleanup/sweeper.js'
import { DomainError } from '../errors.js'
import { ArtifactEdgeService } from './distributed/edges.js'
import { PostgresArtifactEdgeRepository } from './distributed/postgres.js'
import { PostgresArtifactEdgeAuthorization, type AcceptedArtifactAttemptFence } from './distributed/authorization.js'
import { NativeArtifactOutputs } from '../runs/remote/nativeArtifactOutputs.js'
import { PostgresNativeArtifactOutputRepository } from '../runs/remote/nativeArtifactOutputPostgres.js'

const productionStores = new WeakSet<TemporaryFileService>()

// referenceResolver is FIL-37's agent read seam; FIL-36's human reference service is composed below.
export function registerProductionFileStorage(app: FastifyInstance, pool: pg.Pool, config: ApiConfig,
  referenceResolver?: FileReferenceResolver): TemporaryFileService {
  const repository = new PostgresFileRepository(pool, readFileRetentionSnapshot)
  const bytes = new FileByteStorage(config.fileStorageRoot ?? defaultFileStorageRoot(), MAX_FILE_BYTES,
    [config.harnesses.workspaceRoot, config.workspaceStorageRoot ?? workspaceStorageRoot()])
  const service = new TemporaryFileService(repository, bytes, new PostgresFileConversationAuthorization(pool))
  productionStores.add(service)
  const references = new FileReferenceService(repository, bytes, new PostgresFileReferenceAuthorization(pool),
    new PostgresCommandCoordinator(pool))
  // The MCP endpoint is composed before this helper. Its onReady hook binds this same service.
  app.decorate('temporaryFileService', service)
  app.decorate('fileReferenceService', references)
  // FIL-37: authenticated agent-tool/conversation adapters bind this read-only service, not FIL-36 writes.
  const agentReferences = new AgentReferenceService({
    files: repository, bytes, authorization: new PostgresAgentReferenceAuthorization(pool),
    reads: new PostgresReferenceReadRepository(pool),
  })
  app.decorate('agentReferenceService', agentReferences)
  registerFileRoutes(app, service)
  registerFileReferenceRoutes(app, references)
  registerProductionFileTools(app, pool, service, referenceResolver ?? agentFileReferenceResolver(agentReferences, repository, bytes))
  const cleanup = new TemporaryFileCleanupSweeper(new PostgresFileCleanupRepository(pool),
    new ManagedFileCleanupBytes(bytes), (error, context) => app.log.warn({ err: error, ...context }, 'temporary file cleanup failed'))
  app.addHook('onReady', async () => { await bytes.initialize(); cleanup.start() })
  // Drain the sweeper before server.ts's onClose hooks dispose the shared pool.
  app.addHook('preClose', () => cleanup.stop())
  return service
}

/** Publication and recovery share the original canonical store, ledger and
 * accepted-attempt authority. Callers supply genuine W08 authority/transfer ports. */
export function createProductionDistributedArtifacts(input: { pool: pg.Pool; files: TemporaryFileService;
  mainId: string; attempts: AcceptedArtifactAttemptFence; authority: ArtifactPublicationAuthority;
  readAuthority?: Pick<ArtifactPublicationAuthority, 'authorize'>; transfers: VerifiedArtifactReader }) {
  if (!productionStores.has(input.files)) throw new DomainError('NATIVE_ARTIFACT_STORE_UNAVAILABLE', 'The original production file store is required.', 503)
  const ledger = new PostgresDistributedPublicationLedger(input.pool)
  const readAuthority = input.readAuthority ?? input.authority
  const results = new CanonicalNativeArtifactResults(input.files, ledger, readAuthority)
  const edges = new ArtifactEdgeService(new PostgresArtifactEdgeRepository(input.pool), input.files.repository, input.files.bytes,
    new PostgresArtifactEdgeAuthorization(input.attempts))
  return {
    publications: new DistributedArtifactPublicationService(input.files, ledger, input.transfers, input.authority),
    results, edges,
    outputs: new NativeArtifactOutputs(results, new PostgresNativeArtifactOutputRepository(input.pool, input.mainId), readAuthority, edges),
  }
}
