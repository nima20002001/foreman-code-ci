import { homedir } from 'node:os'
import { join } from 'node:path'

// Kept free of server-only imports: the installed Worker bundle uses it.
export const detectedClaudeProfilePath = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
