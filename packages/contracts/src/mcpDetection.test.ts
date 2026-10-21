import { describe, expect, it } from 'vitest';

import { McpCredentialArrangementSchema } from './mcpDetection.js';
import { McpDetectionSchema } from './index.js';

describe('MCP credential arrangement', () => {
  it.each([
    { kind: 'environment_variable', environmentVariable: 'GRAPHQL_MCP_TOKEN' },
    { kind: 'scoped_http_header' },
    { kind: 'unknown' },
  ])('accepts credential mechanism evidence %j', (arrangement) => {
    expect(McpCredentialArrangementSchema.parse(arrangement)).toEqual(arrangement);
  });

  it.each([
    { kind: 'scoped_http_header', Authorization: 'secret' },
    { kind: 'scoped_http_header', token: 'secret' },
    { kind: 'environment_variable', environmentVariable: 'SECRET_TOKEN' },
    { kind: 'unknown', password: 'secret' },
  ])('rejects credential values or unrecognized references %j', (arrangement) => {
    expect(McpCredentialArrangementSchema.safeParse(arrangement).success).toBe(false);
  });

  it('preserves existing environment-only detection and accepts the additive mechanism field', () => {
    const legacy = { harness: 'codex', serverName: 'graphql', state: 'connected', endpointMatches: true,
      credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN', checkedAt: '2026-10-01T00:00:00.000Z' };
    expect(McpDetectionSchema.parse(legacy)).toEqual(legacy);
    const header = { ...legacy, harness: 'claude', credentialEnvironmentVariable: null,
      credentialArrangement: { kind: 'scoped_http_header' } };
    expect(McpDetectionSchema.parse(header)).toEqual(header);
  });
});
