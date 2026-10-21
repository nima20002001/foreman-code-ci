import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { WorkspaceCreateInput } from '@foreman-code/contracts/management'
import pg from 'pg'
import filesystem from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { buildApp } from '../../src/app.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { PostgresFoundationSettingsRepository } from '../../src/modules/settings/foundation.js'
import { WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../../src/modules/workspaces/management.js'

interface Request {
  database: pg.PoolConfig
  parentPath: string
  token: string
  input: WorkspaceCreateInput
  interrupt: boolean | 'staged'
  reconcilePublication?: string
}

process.once('message', async (request: Request) => {
  const pool = new pg.Pool(request.database)
  const commands = new PostgresCommandCoordinator(pool)
  const locations = new WorkspaceLocationService(pool, commands, undefined, 'runner-local')
  const defaults = new PostgresFoundationSettingsRepository(pool, request.parentPath)
  const workspaces = new WorkspaceManagementService(pool, commands, locations, defaults, request.parentPath)
  const app = buildApp({ logger: false, readiness: {
    database: { ping: async () => {} }, checkpoints: { ping: async () => {} },
  }, operator: { access: new PostgresAccessService(pool),
    services: { commands, locations, workspaces } as unknown as OperatorServices } })
  const client = new Client({ name: 'workspace-recovery-process', version: '1' })
  try {
    if (request.reconcilePublication) {
      const gate = request.reconcilePublication
      const remove = filesystem.rmdir
      filesystem.rmdir = async (...args: Parameters<typeof remove>) => {
        if (String(args[0]).includes('.graphql-project-')) {
          await filesystem.writeFile(join(gate, 'release'), '')
          for (let attempt = 0; ; attempt++) {
            try { await filesystem.stat(join(gate, 'published')); break }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= 1000) throw error
              await new Promise(done => setTimeout(done, 10))
            }
          }
        }
        return remove(...args)
      }
      syncBuiltinESMExports()
    }
    if (request.interrupt) {
      const query = pg.Client.prototype.query as unknown as
        (this: pg.Client, ...args: unknown[]) => Promise<pg.QueryResult>
      // Hold a real uncommitted command after its directory is published.
      pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
        if (request.interrupt === true && typeof args[0] === 'string' && args[0].includes('insert into workspaces')) {
          process.send!({ phase: 'provisioned' })
          return new Promise(() => {})
        }
        if (request.interrupt === 'staged' && typeof args[0] === 'string'
          && args[0].startsWith('update workspace_project_provisioning set identity')) {
          return query.apply(this, args).then(() => {
            process.send!({ phase: 'staged' })
            return new Promise(() => {})
          })
        }
        return query.apply(this, args)
      } as never
    }
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => request.token },
    }))
    const result = await client.callTool({ name: 'workspace_create', arguments: request.input })
    process.send!({ phase: 'completed', result })
  } catch (error) {
    process.send!({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
    process.exitCode = 1
  } finally {
    await client.close()
    await app.close()
    await pool.end()
    process.disconnect?.()
  }
})
