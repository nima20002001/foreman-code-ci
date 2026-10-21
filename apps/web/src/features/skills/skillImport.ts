import { MAX_SKILL_INSTRUCTIONS_CHARS } from '@foreman-code/contracts'

export type SkillImport = { name: string; text: string } | { error: string }

const EXTENSIONS = ['.md', '.markdown', '.txt']
/** UTF-8 can use up to four bytes per character; reject clearly oversized files before reading. */
const MAX_BYTES = MAX_SKILL_INSTRUCTIONS_CHARS * 4

/** One Markdown file becomes editor text only. Nothing is executed, fetched or expanded. */
export async function readSkillFile(file: File): Promise<SkillImport> {
  const lower = file.name.toLowerCase()
  if (!EXTENSIONS.some((extension) => lower.endsWith(extension))) return { error: 'Choose a single Markdown (.md) or text file. Folders, archives and packages are not supported.' }
  if (file.size > MAX_BYTES) return { error: 'This file is too large for a skill.' }
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()) } catch {
    return { error: 'This file is not valid UTF-8 text.' }
  }
  text = text.startsWith('\uFEFF') ? text.slice(1) : text
  if (!text.trim()) return { error: 'This file is empty.' }
  if (text.length > MAX_SKILL_INSTRUCTIONS_CHARS) return { error: `Skill instructions can be at most ${MAX_SKILL_INSTRUCTIONS_CHARS.toLocaleString()} characters.` }
  return { name: file.name.replace(/\.(md|markdown|txt)$/i, '').slice(0, 200), text }
}
