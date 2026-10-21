import { dirname, resolve } from 'node:path'
import type { SqlQuery } from '../../infrastructure/transaction.js'

/** Ancestors are shared so siblings proceed; the selected directory excludes every overlapping claim. */
export async function lockWorkspaceFolders(sql: SqlQuery, paths: readonly string[]): Promise<void> {
  const targets = new Set(paths.map(path => resolve(path)))
  const directories = new Set<string>()
  for (const target of targets) {
    let path = target
    for (;;) {
      directories.add(path)
      const parent = dirname(path)
      if (parent === path) break
      path = parent
    }
  }
  // All callers take ancestors first, including operations that rename or remove several folders.
  for (const path of [...directories].sort()) {
    const statement = targets.has(path)
      ? 'select pg_advisory_xact_lock(hashtext($1))'
      : 'select pg_advisory_xact_lock_shared(hashtext($1))'
    await sql.query(statement, [`workspace-folder-use:${path}`])
  }
}
