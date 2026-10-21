import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRuntimeBuildIdentity } from '@foreman-code/contracts/runtime-build-identity-node'
import { RuntimeBuildIdentitySchema, type RuntimeBuildIdentity } from '@foreman-code/contracts'
import type { FastifyInstance } from 'fastify'
import { DomainError } from '../modules/errors.js'
import type pg from 'pg'
import { RuntimeIdentitySchema, RUNTIME_INSTALLATION_HEADER, RuntimeInstallationHeaderSchema, type RuntimeIdentity } from '@foreman-code/contracts'
import { createRuntimeIdentity } from '@foreman-code/contracts/runtime-identity-node'

export const installationIdentityMigration = { version: 264403, sql: `
  create table application_installation (
    singleton boolean primary key default true check (singleton),
    id uuid not null default gen_random_uuid()
  );
  insert into application_installation (singleton) values (true);
` }

export async function readRuntimeIdentity(pool: Pick<pg.Pool, 'query'>, root: string, connectionString: string) {
  const result = await pool.query<{ id: string }>('select id from application_installation where singleton = true')
  return RuntimeIdentitySchema.parse(createRuntimeIdentity(root, connectionString, result.rows[0]?.id ?? ''))
}

let capturedBuildIdentity: RuntimeBuildIdentity | undefined

/** Capture once at startup; a running API must keep its compiled build identity if its checkout changes. */
export function readRuntimeBuildIdentity() {
  if (capturedBuildIdentity) return capturedBuildIdentity
  const stamp = new URL('../runtime-build.json', import.meta.url)
  const identity = existsSync(stamp) ? JSON.parse(readFileSync(stamp, 'utf8')) as unknown
    : createRuntimeBuildIdentity(fileURLToPath(new URL('../../../../', import.meta.url)))
  capturedBuildIdentity = RuntimeBuildIdentitySchema.parse(identity)
  return capturedBuildIdentity
}

/** Reject a stale browser document before route handlers can admit commands or touch files. */
export function registerRuntimeInstallationSecurity(app: FastifyInstance, identity: () => Promise<RuntimeIdentity>) {
  app.addHook('preHandler', async request => {
    const path = request.url.split('?')[0]
    if (!path?.startsWith('/api/') || path === '/api/runtime/identity' || path === '/api/local-human') return
    const expected = request.headers[RUNTIME_INSTALLATION_HEADER]
    const browserMutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
      && request.headers['sec-fetch-site'] !== undefined
    if (expected === undefined && !browserMutation) return
    const parsed = RuntimeInstallationHeaderSchema.safeParse(expected)
    if (!parsed.success || parsed.data !== (await identity()).installationId) {
      throw new DomainError('INSTALLATION_CHANGED', 'This app installation changed. Reload before continuing.', 409)
    }
  })
}
