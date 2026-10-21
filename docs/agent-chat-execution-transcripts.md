# Workflow execution transcripts in Agent chat

Agent chat reads expose `sourceTranscript` separately from the follow-up
conversation. It contains the selected execution ID, lifecycle state, native
text revision, and public user/assistant messages retained in native events.
Reading it does not create, attach, fork, resume, or control a native session.
Private reasoning, tool payloads, and child-session text are excluded.

The Board polls this transcript while an execution starts or runs and retains
it after completion, including when the original harness or profile is
unavailable. Responses contain at most 100 recent source messages and 128 KiB
of source text. Truncated messages expose their original byte count; older
source messages are indicated by `hasEarlierMessages`.

Follow-up messages use the existing separate conversation and fork only a
completed execution. Other executions in the parent Run may still be working.
Starting/running workflow executions remain read-only in chat: chat grants
do not confer permission to interrupt or steer the workflow's native session.

HTTP and Operator MCP use the same service and read grants. `agent_chat_read`
returns the same source transcript. Read its `executionId` when requesting
session controls for a repeated node. Context-only control reads follow the
same Board execution choice as context-only chat reads; control writes retain
the requirement to select an execution when several exist.
