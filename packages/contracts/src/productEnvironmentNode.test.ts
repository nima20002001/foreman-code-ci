import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadProductEnvFile } from './productEnvironmentNode.mjs'

describe('product env file selection', () => {
  it.each(['GRAPHQL_API_ENV_FILE', 'FOREMAN_CODE_API_ENV_FILE'])('selects %s before loading and keeps process precedence', name => {
    const directory = mkdtempSync(join(tmpdir(), 'foreman-env-'))
    try {
      const custom = join(directory, 'custom.env')
      writeFileSync(custom, 'FOREMAN_CODE_WEB_PORT=5199\nGRAPHQL_LAPTOP_EXECUTION_ENABLED=0\nDATABASE_URL=file-db\n')
      const environment: NodeJS.ProcessEnv = { [name]: custom, GRAPHQL_WEB_PORT: '5198', DATABASE_URL: 'process-db' }
      loadProductEnvFile(join(directory, 'missing-default.env'), environment)
      expect(environment.FOREMAN_CODE_WEB_PORT).toBe('5198')
      expect(environment.FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED).toBe('0')
      expect(environment.DATABASE_URL).toBe('process-db')
      expect(environment.GRAPHQL_WEB_PORT).toBeUndefined()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('rejects conflicting selectors before accessing either file and leaves the environment unchanged', () => {
    const environment = { GRAPHQL_API_ENV_FILE: '/missing/legacy.env', FOREMAN_CODE_API_ENV_FILE: '/missing/canonical.env' }
    const original = { ...environment }
    expect(() => loadProductEnvFile(undefined, environment)).toThrow('FOREMAN_CODE_API_ENV_FILE conflicts with GRAPHQL_API_ENV_FILE')
    expect(environment).toEqual(original)
  })
})
