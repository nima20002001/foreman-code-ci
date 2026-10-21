import { basename } from 'node:path'
import type { CodexPluginDetailResult } from '@foreman-code/contracts/management'
import { BoundedPluginFiles, pluginObject, safePluginPart } from './boundedPluginFiles.js'

const names = (value: unknown): string[] => Object.keys(pluginObject(value)).sort()
const absent = Symbol('absent')

async function declarations(files: BoundedPluginFiles, declaration: unknown, fallback: string, key: string): Promise<string[]> {
  if (declaration === absent) {
    const file = await files.json(fallback)
    if (!file) return [] // Only ENOENT, never an unreadable or malformed component.
    if (!Object.hasOwn(file, key) && Object.keys(file).length) throw new Error('Unsupported component file.')
    return names(file[key] ?? {})
  }
  if (key === 'apps' && typeof declaration !== 'string') throw new Error('Apps declarations must be a relative file path.')
  if (key === 'mcpServers' && Array.isArray(declaration)) throw new Error('Unsupported MCP declaration array.')
  const values = Array.isArray(declaration) ? declaration : [declaration]
  if (key === 'hooks' && Array.isArray(declaration) && !values.every((value) => typeof value === 'string')
    && !values.every((value) => value && typeof value === 'object' && !Array.isArray(value))) throw new Error('Mixed hook declaration arrays are unsupported.')
  if (values.length > 64) throw new Error('Too many component declarations.')
  const result = new Set<string>()
  for (const value of values) {
    if (Array.isArray(value)) throw new Error('Nested component declarations are unsupported.')
    if (typeof value === 'string' && !value.startsWith('./')) throw new Error('Declared plugin paths must start with ./')
    const data = typeof value === 'string' ? await files.json(value) : pluginObject(value)
    if (!data) throw new Error('Declared component is missing.')
    // An inline { hooks: { SessionStart: [...] } } describes SessionStart, not "hooks".
    for (const name of names(Object.hasOwn(data, key) ? data[key] : data)) result.add(name)
  }
  return [...result].sort()
}
const field = (record: Record<string, unknown>, key: string) => Object.hasOwn(record, key) ? record[key] : absent

export async function inspectCodexPluginBundle(root: string, requestSignal?: AbortSignal): Promise<CodexPluginDetailResult['contents']> {
  const deadline = AbortSignal.timeout(2_000)
  const signal = requestSignal ? AbortSignal.any([requestSignal, deadline]) : deadline
  try {
    const files = await BoundedPluginFiles.create(root, signal)
    const rootManifest = await files.json('plugin.json')
    const rootSchema = rootManifest?.$schema
    if (typeof rootSchema === 'string' && rootSchema.startsWith('https://agent-plugins.org/schemas/')
      && rootSchema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') throw new Error('Unsupported portable manifest version.')
    // An unrelated root JSON file is not the portable manifest; native lookup falls back to legacy.
    const portable = rootSchema === 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' ? rootManifest : undefined
    let manifest: Record<string, unknown>
    let extension: Record<string, unknown>
    if (portable) {
      if (portable.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
        || typeof portable.name !== 'string' || portable.name.length > 64 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(portable.name) || /--|\.\./.test(portable.name)) throw new Error('Unsupported portable manifest.')
      for (const key of ['version', 'description', 'homepage', 'repository', 'license']) {
        if (Object.hasOwn(portable, key) && typeof portable[key] !== 'string') throw new Error('Invalid portable metadata.')
      }
      if (Object.hasOwn(portable, 'keywords') && (!Array.isArray(portable.keywords) || !portable.keywords.every((value) => typeof value === 'string'))) throw new Error('Invalid portable keywords.')
      if (Object.hasOwn(portable, 'author')) {
        for (const [key, value] of Object.entries(pluginObject(portable.author))) {
          if (!['name', 'email', 'url'].includes(key) || typeof value !== 'string') throw new Error('Invalid portable author.')
        }
      }
      manifest = portable
      const extensions = portable.extensions === undefined ? {} : pluginObject(portable.extensions)
      // The inline extension REPLACES, rather than merges with, the compatibility overlay.
      extension = Object.hasOwn(extensions, 'com.openai') ? pluginObject(extensions['com.openai'])
        : await files.json('.codex-plugin/plugin.json') ?? {}
    } else {
      const legacy = await files.json('.codex-plugin/plugin.json')
      if (!legacy || typeof legacy.name !== 'string' || !safePluginPart(legacy.name)) throw new Error('Unsupported legacy manifest.')
      manifest = legacy
      extension = legacy
    }
    const skillDeclaration = portable ? absent : field(manifest, 'skills')
    const skillDirectories = skillDeclaration === absent ? ['skills']
      : typeof skillDeclaration === 'string' ? [skillDeclaration] : Array.isArray(skillDeclaration) ? skillDeclaration : undefined
    if (!skillDirectories || skillDirectories.length > 32) throw new Error('Unsupported skill declaration.')
    const skills = new Set<string>()
    let visited = 0
    const scanSkills = async (directory: string, depth: number, declared: boolean): Promise<void> => {
      if (++visited > 512 || depth > 8) throw new Error('Skill traversal exceeds the inspection limit.')
      const entries = await files.directories(directory)
      if (entries === undefined) {
        if (declared) throw new Error('Declared skills are missing.')
        return
      }
      if (!portable && await files.regular(`${directory}/SKILL.md`)) skills.add(basename(directory))
      for (const name of entries) {
        if (portable) { if (await files.regular(`${directory}/${name}/SKILL.md`)) skills.add(name) }
        else await scanSkills(`${directory}/${name}`, depth + 1, false)
      }
    }
    for (const directory of skillDirectories) {
      if (typeof directory !== 'string' || (skillDeclaration !== absent && !directory.startsWith('./'))) throw new Error('Unsupported skill path.')
      await scanSkills(directory, 0, skillDeclaration !== absent)
    }
    const mcpServers = await declarations(files, portable ? absent : field(manifest, 'mcpServers'), portable ? 'mcp.json' : '.mcp.json', 'mcpServers')
    const hooks = await declarations(files, field(extension, 'hooks'), 'hooks/hooks.json', 'hooks')
    const apps = await declarations(files, field(extension, 'apps'), '.app.json', 'apps')
    signal.throwIfAborted()
    return { status: 'known', skills: [...skills].sort(), hooks, mcpServers, apps }
  } catch {
    requestSignal?.throwIfAborted()
    return { status: 'unknown' }
  }
}
