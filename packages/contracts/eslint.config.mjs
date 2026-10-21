import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { foremanLint } from '../../scripts/eslint-plugin-foreman/index.mjs'

export default tseslint.config(
  { ignores: ['dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', 'ci-test-runner.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  ...foremanLint(import.meta.dirname),
  {
    // Graph protocol primitives have one definition, in src/wave25/graphPrimitives.ts.
    // protocol.ts only holds the event/snapshot envelopes built on them.
    files: ['**/*.ts'],
    // The package entry re-exports protocol.ts wholesale (`export *`), which names no primitive.
    ignores: ['src/wave25/index.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        regex: '(^|/)wave25/protocol(\\.js)?$|^\\./protocol(\\.js)?$',
        importNames: [
          'RUN_GRAPH_PROTOCOL_VERSION', 'RUN_GRAPH_LIMITS', 'GraphIdSchema', 'GraphDigestSchema',
          'GraphSequenceSchema', 'GraphSequence', 'RunGraphScopeSchema', 'RunGraphScope', 'GraphEvidenceSchema',
          'GraphEvidence', 'AgentGraphExecutionIdentitySchema', 'AgentGraphExecutionIdentity',
          'JobGraphExecutionIdentitySchema', 'GraphExecutionIdentitySchema', 'extendGraphExecutionIdentitySchema',
          'GraphExecutionIdentity', 'NodeResolutionSchema', 'NodeResolution', 'InputBindingSchema', 'InputBinding',
          'GraphNodeStateSchema', 'GraphActivitySchema', 'GraphActivity', 'GraphAttentionSchema', 'GraphAttention',
          'GraphRunStateSchema', 'GraphInteractionSchema', 'GraphReviewSchema', 'GraphFactSchema', 'GraphFact',
          'GraphResetReasonSchema', 'PublicGraphProjectionSchema', 'PublicGraphProjection',
          'PublicGraphTopologySchema', 'PublicGraphTopology', 'RunGraphCurrentStateSchema', 'RunGraphCurrentState',
          'RunGraphTopologySchema', 'RunGraphTopology', 'RunGraphErrorCodeSchema', 'RunGraphErrorCode',
          'RunGraphErrorResponseSchema', 'RunGraphCapabilitiesSchema', 'DISABLED_RUN_GRAPH_CAPABILITIES',
          'RUN_GRAPH_ROUTES', 'RUN_GRAPH_MCP_TOOLS', 'sameGraphScope', 'graphFactExecutions',
          'GraphEffectIdentitySchema', 'GraphEffectIdentity', 'GraphEffectSchema', 'GraphEffect',
          'PublicGraphDeltaSchema', 'PublicGraphDelta',
        ],
        message: 'Import graph primitives from wave25/graphPrimitives.js; protocol.ts must not redefine them.',
      }] }],
    },
  },
)
