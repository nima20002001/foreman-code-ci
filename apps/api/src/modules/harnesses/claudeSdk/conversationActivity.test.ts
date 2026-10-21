import { describe, expect, it } from 'vitest'
import { claudeConversationActivity } from './conversationActivity.js'

describe('Claude conversation activity', () => {
  it('omits known tool input and output from details and titles', () => {
    const event = {
      type: 'claude.tool',
      payload: {
        itemId: 'claude:tool:read', name: 'Read', status: 'completed',
        input: { file_path: '/private/customer-records.txt' },
        output: 'Private customer record contents',
      },
    }
    expect(claudeConversationActivity(event, 'request')).toEqual({
      id: 'claude:tool:read', requestId: 'request', kind: 'file_read',
      title: 'Read file', status: 'completed',
    })
  })

  it('projects a tool event without input or output bodies', () => {
    const event = {
      type: 'claude.tool',
      payload: { itemId: 'claude:tool:command', name: 'Bash', status: 'running' },
    }
    expect(claudeConversationActivity(event, 'request')).toEqual({
      id: 'claude:tool:command', requestId: 'request', kind: 'tool',
      title: 'Run command', status: 'running',
    })
  })
})
