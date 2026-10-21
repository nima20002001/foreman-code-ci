import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentSubjectSchema, EngineChatReadbackSchema, NodeBrowserSettingsSchema,
  collaborationContractFixtures as fixture, effectiveGraphqlTools,
} from '@foreman-code/contracts';

test('Worker consumes execution and consultation readback without creating a conversation', () => {
  for (const readback of [fixture.executionReadback, fixture.consultationReadback]) {
    assert.deepEqual(EngineChatReadbackSchema.parse(readback), readback);
    assert.equal(Object.hasOwn(readback.messages[0], 'conversationId'), false);
  }
  const subject = AgentSubjectSchema.parse({ kind: 'coordinator_consultation', agent: fixture.agent, binding: fixture.binding });
  assert.equal(subject.agent.productRole, 'master');
  assert.equal(subject.binding.purpose, 'consultation');
  assert.deepEqual(NodeBrowserSettingsSchema.parse({ enabled: false }), { enabled: false });
});

test('Master and legacy saved defaults never activate dormant collaboration tools', () => {
  for (const role of ['master', 'orchestrator', 'coder']) {
    const tools = effectiveGraphqlTools(role, undefined);
    for (const unavailable of ['memory_card_create', 'browser_action', 'workflow_chat_post']) {
      assert.equal(tools.includes(unavailable), false);
    }
    assert.equal(tools.includes('bug_report'), true);
  }
});
