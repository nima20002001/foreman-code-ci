import { writeFileSync, renameSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

export function writeHeavyJobRecord(path, record, stagingDirectory = dirname(path)) {
  const temporary = join(stagingDirectory, `.owner-${randomUUID()}`)
  try {
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** Unresolved acquired tickets still own capacity when their slot record is missing. */
export function retainedHeavyJobTokens(tickets, slots, held) {
  const registered = new Set(slots.flatMap(slot => slot?.token ? [slot.token] : []))
  if (held?.token) registered.add(held.token)
  return new Set(tickets.flatMap(ticket => {
    if (!ticket?.token || registered.has(ticket.token)) return []
    const acquired = ticket.phase === 'running' || ticket.phase === 'acquiring'
      || ticket.phase === undefined && Number.isSafeInteger(ticket.pgid) && ticket.pgid > 0
    return acquired ? [ticket.token] : []
  }))
}
