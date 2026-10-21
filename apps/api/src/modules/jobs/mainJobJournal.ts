import { lstat } from 'node:fs/promises'
import { DomainError } from '../errors.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import type { JobSql } from './repository.js'
import type { SourcePreparationClosure } from '@foreman-code/contracts/source-admission'

/** First installation has no operations to recover; missing retained history never authorizes a fresh journal. */
export async function openMainJobJournal(input: {
  sql: JobSql
  path: string
  mainId: string
  initialization: 'bootstrap' | 'existing-only'
}): Promise<RemoteOperationJournal> {
  const existing = await lstat(input.path).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing) {
    const journal = await RemoteOperationJournal.open(input.path)
    try {
      await retainMainJobSourceClosures(input.sql, journal)
      return journal
    } catch (error) {
      await journal.close()
      throw error
    }
  }
  if (input.initialization === 'existing-only') throw recoveryRequired()
  const row = (await input.sql.query<{ owned: boolean }>(`select
    exists(select 1 from job_executions where accepted_spec #>> '{target,hostRef,kind}'='main'
      and accepted_spec #>> '{target,mainInstallationId}'=$1)
    or exists(select 1 from job_runtime_qualification_approvals
      where native_admission #>> '{hostRef,kind}'='main'
        and native_admission->>'mainInstallationId'=$1) as owned`, [input.mainId])).rows[0]
  if (!row || row.owned) throw recoveryRequired()
  return RemoteOperationJournal.open(input.path, { initializeNewInstallation: true })
}

export async function retainMainJobSourceClosures(sql: JobSql, journal: RemoteOperationJournal): Promise<void> {
  const operations = (await journal.jobOperations()).filter(receipt => receipt.terminal
    && ['complete', 'failed'].includes(receipt.publication)).map(receipt => receipt.intent.operationId)
  if (!operations.length) return
  const rows = (await sql.query<{ closure: SourcePreparationClosure }>(
    `select closure from source_preparation_reconciliations
      where operation_id=any($1::text[]) and status='closed'`, [operations])).rows
  for (const row of rows) {
    if (!await journal.isJobRetired(row.closure.operationId)) {
      await journal.jobSourceReclaimed(row.closure.operationId, row.closure)
    }
  }
  await journal.pruneFinishedRuntime()
}

function recoveryRequired() {
  return new DomainError('JOB_JOURNAL_RECOVERY_REQUIRED',
    'The Main Job journal is missing. Recover its original operation history before starting more Jobs.', 409)
}
