import type { FastifyInstance } from 'fastify'

import { requirePrincipal } from '../modules/access/http.js'
import type { FileRetentionService } from '../modules/files/retention.js'

export const FILE_RETENTION_PATH = '/api/management/file-retention'

/** Uses the existing authenticated management boundary, including browser Origin/CSRF checks. */
export function registerFileRetentionRoutes(app: FastifyInstance, service: FileRetentionService): void {
  app.get<{ Querystring: unknown }>(FILE_RETENTION_PATH, async (request) =>
    service.get(requirePrincipal(request), 'http', request.query))
  app.post<{ Body: unknown }>(FILE_RETENTION_PATH, async (request) =>
    service.save(requirePrincipal(request), 'http', request.body))
  app.post<{ Body: unknown }>(`${FILE_RETENTION_PATH}/preview`, async (request) =>
    service.preview(requirePrincipal(request), 'http', request.body))
}
