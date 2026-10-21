const reads = ['memory_board_get', 'memory_board_changes_read'] as const
const writes = ['memory_card_create', 'memory_card_update', 'memory_note_create', 'memory_note_update', 'memory_note_archive'] as const
export const memoryToolNames: readonly string[] = [...reads, ...writes]
export type MemoryAccess = 'none' | 'read' | 'write' | 'custom'
export function memoryAccess(tools: readonly string[]): MemoryAccess {
  const selected = new Set(tools.filter((tool) => memoryToolNames.includes(tool)))
  if (selected.size === 0) return 'none'
  if (selected.size === reads.length && reads.every((tool) => selected.has(tool))) return 'read'
  if (selected.size === memoryToolNames.length && memoryToolNames.every((tool) => selected.has(tool))) return 'write'
  return 'custom'
}
export function replaceMemoryAccess(tools: readonly string[], access: Exclude<MemoryAccess, 'custom'>): string[] {
  const retained = tools.filter((tool) => !memoryToolNames.includes(tool))
  return [...retained, ...(access === 'none' ? [] : access === 'read' ? reads : memoryToolNames)]
}
