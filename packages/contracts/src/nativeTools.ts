import { z } from 'zod';
import { APP_MCP_SERVER_NAMES } from './product.js';

export const NativeToolsSchema = z.object({
  mcpServers: z.array(z.string().trim().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(500)
    .refine(names => new Set(names).size === names.length, 'MCP server names must be unique')
    .optional().describe('Native MCP server allowlist. Omit to inherit host configuration; [] allows only Foreman Code.'),
  apps: z.boolean().optional().describe('Load native apps/connectors and plugins. Omit to inherit host configuration.'),
}).strict().describe('Native tool loading policy. Foreman Code remains available under its existing role and access grants.');
export type NativeTools = z.infer<typeof NativeToolsSchema>;

export function nativeMcpServerAllowed(name: string, policy?: NativeTools): boolean {
  if (APP_MCP_SERVER_NAMES.some(appName => appName === name)) return true;
  if (name === 'codex_apps' && policy?.apps === false) return false;
  return policy?.mcpServers === undefined || policy.mcpServers.includes(name);
}

export function nativeToolsSummary(policy?: NativeTools): string {
  let servers = 'Host MCP servers';
  if (policy?.mcpServers !== undefined) {
    const external = policy.mcpServers.filter(name => !APP_MCP_SERVER_NAMES.some(appName => appName === name)
      && nativeMcpServerAllowed(name, policy));
    servers = ['Foreman Code', ...external].join(', ');
  }
  let apps = 'apps inherit host settings';
  if (policy?.apps === true) apps = 'apps on';
  if (policy?.apps === false) apps = 'apps off';
  return `${servers}; ${apps}`;
}
