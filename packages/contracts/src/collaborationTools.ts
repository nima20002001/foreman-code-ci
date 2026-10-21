import type { GraphqlAgentTool, GraphqlToolOverride } from './graphqlMcpTools.js';
/** Contract names reserve the feature seam. They are never evidence of a live handler. */
const roles = ['master', 'orchestrator', 'coder'] as const;

export const COLLABORATION_AGENT_TOOLS = {
  memory_board_get: { label: 'Read memory board', description: 'Read the scoped workflow or workspace board.', roles, readOnly: true },
  memory_board_changes_read: { label: 'Read board changes', description: 'Read committed changes from a bounded cursor.', roles, readOnly: true },
  memory_card_create: { label: 'Create task', description: 'Create a task with scoped work selections; duplicate titles return the existing card.', roles, readOnly: false },
  memory_card_update: { label: 'Update task', description: 'Apply a scoped task patch with optional revision and command identity.', roles, readOnly: false },
  memory_note_create: { label: 'Create note', description: 'Create a scoped pinned note.', roles, readOnly: false },
  memory_note_update: { label: 'Update note', description: 'Update a scoped note without reordering unrelated notes.', roles, readOnly: false },
  memory_note_archive: { label: 'Archive or restore note', description: 'Set a scoped note archive state.', roles, readOnly: false },
  browser_session_get: { label: 'Read browser session', description: 'Read this subject’s assigned browser session.', roles, readOnly: true },
  browser_tabs_list: { label: 'List owned tabs', description: 'List only this browser session’s leased tabs.', roles, readOnly: true },
  browser_tab_create: { label: 'Create tab', description: 'Create a tab owned by the assigned session.', roles, readOnly: false },
  browser_tab_select: { label: 'Select tab', description: 'Select an owned tab for the agent without changing the viewer selection.', roles, readOnly: false },
  browser_tab_close: { label: 'Close tab', description: 'Close one owned tab.', roles, readOnly: false },
  browser_state_read: { label: 'Read page state', description: 'Observe an owned tab through its control lease.', roles, readOnly: true },
  browser_screenshot: { label: 'Read screenshot', description: 'Observe a bounded screenshot of an owned tab.', roles, readOnly: true },
  browser_action: { label: 'Act on page', description: 'Perform a typed page action through the session ownership and control checks.', roles, readOnly: false },
  workflow_chat_read: { label: 'Read group chat', description: 'Read bounded posts in this workflow’s channel.', roles: [...roles, 'operator'], readOnly: true },
  workflow_chat_post: { label: 'Post to group chat', description: 'Publish a scoped agent post without resolving user mentions.', roles: [...roles, 'operator'], readOnly: false },
  workflow_chat_deliveries_read: { label: 'Read chat deliveries', description: 'Read scoped delivery receipt state.', roles: [...roles, 'operator'], readOnly: true },
} as const;

export type CollaborationAgentTool = keyof typeof COLLABORATION_AGENT_TOOLS;
export type MemoryBoardToolAccess = 'none' | 'read' | 'write';
export function memoryBoardTools(access: MemoryBoardToolAccess): CollaborationAgentTool[] {
  return (Object.keys(COLLABORATION_AGENT_TOOLS) as CollaborationAgentTool[])
    .filter((name) => name.startsWith('memory_') && access !== 'none'
      && (access === 'write' || COLLABORATION_AGENT_TOOLS[name].readOnly));
}

/** Applied only by explicit new-configuration creation, never inferred for saved defaults. */
export function newAgentMemoryBoardAccess(role: 'master' | 'orchestrator' | 'coder'): MemoryBoardToolAccess {
  return role === 'coder' ? 'read' : 'write';
}

export function isCollaborationAgentTool(name: string): name is CollaborationAgentTool {
  return Object.prototype.hasOwnProperty.call(COLLABORATION_AGENT_TOOLS, name);
}

export const BROWSER_AGENT_TOOL_NAMES = Object.keys(COLLABORATION_AGENT_TOOLS)
  .filter((name): name is Extract<keyof typeof COLLABORATION_AGENT_TOOLS, `browser_${string}`> => name.startsWith('browser_'));

/** Browser opts this workflow node into its tools; explicit node exclusions still win. */
export function withBrowserToolDefaults<T extends {
  browser?: { enabled: boolean } | undefined;
  graphqlTools?: GraphqlToolOverride | undefined;
}>(node: T) {
  if (!node.browser?.enabled) return node;
  const remove = node.graphqlTools?.remove ?? [];
  const add: GraphqlAgentTool[] = [...new Set([...(node.graphqlTools?.add ?? []), ...BROWSER_AGENT_TOOL_NAMES])]
    .filter(tool => !remove.includes(tool));
  return { ...node, graphqlTools: { add, remove: [...remove] } };
}
