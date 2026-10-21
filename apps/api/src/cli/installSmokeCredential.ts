import type pg from 'pg'
import { withTransaction } from '../infrastructure/transaction.js'
import { PostgresAccessService } from '../modules/access/postgres.js'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../modules/jobs/ciAuthority.js'

async function recordAudit(client: pg.PoolClient, principalId: string, action: string): Promise<void> {
  await client.query(
    `insert into management_audit (principal_id, source, action, target_key, outcome, details)
     values ($1, 'cli', $2, $3, 'succeeded', $4::jsonb)`,
    [principalId, action, `credential:${principalId}`, JSON.stringify({ purpose: 'install-ci-smoke' })],
  )
}

/** The installer owns database access; the smoke receives only a short-lived application token. */
export async function withInstallSmokeCredential<T>(pool: pg.Pool, smoke: (token: string) => Promise<T>): Promise<T> {
  const access = new PostgresAccessService(pool)
  const issued = await withTransaction(pool, async client => {
    const credential = await access.issue({
      name: 'Production install CI smoke',
      audience: 'operator',
      grants: [{ actions: ['workspaces:read', ...CI_RUN_ACTIONS, ...CI_GET_ACTIONS], scope: {} }],
      expiresAt: new Date(Date.now() + 10 * 60_000),
    }, client)
    await recordAudit(client, credential.principal.id, 'credential.issue')
    return credential
  })
  try {
    return await smoke(issued.token)
  } finally {
    await withTransaction(pool, async client => {
      await access.revoke(issued.principal.id, client)
      await recordAudit(client, issued.principal.id, 'credential.revoke')
    })
  }
}
