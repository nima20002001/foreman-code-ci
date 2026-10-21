# Foreman managed browser

Use only the browser tools enabled for this exact saved AgentSubject and browser session. The host owns the persistent profile and Chromium process. Different sessions may share sign-in state in one profile, but each session owns its own opaque tab leases.

Start from `browser_session_get` and `browser_tabs_list`, then use `browser_state_read` or `browser_screenshot` before a structured `browser_action`. Keep the returned session, tab, browser generation and control epoch together. Use `browser_tab_select` for your logical selected tab; it does not change another session or the user's chosen viewer tab.

When the user controls the browser, both agent reads and writes pause. Do not create a different session, use a global current tab, send raw CDP, execute arbitrary Python, or use the upstream Harness daemon to bypass that pause. On return, observe fresh page state before acting. Stale generation/epoch errors require current readback, not guessed handles.

Preserve command IDs when a response is lost. Reconcile the original action receipt before a new effect. An unknown result is not proof of failure and must never be blindly repeated. Read-only agents may use only their existing observation tools; this runtime does not expand their sandbox or grant browser mutation authority.

Uploads/downloads use typed phases of `browser_action` with this session's opaque file IDs. Never invent a chat, Run, root path, or another session's file owner. A partial upload cannot be attached. Read completed downloads in bounded chunks; retained output can be read after the session closes until explicitly deleted.

Profile synchronization copies the supported cookie/localStorage state from the chosen source. It does not prove a website login works on another computer. Imported login evidence resets to not checked. Explicit origin observations and user confirmation are separate from transfer freshness. Clearing a local override changes future policy; only a later explicit sync applies source state.

The embedded viewer covers page content. Native file/passkey/extension/system windows may require the explicit same-profile local-window intent. Report an unavailable system window honestly; do not claim a completed page action or start desktop automation.

This adapted skill is shipped with the same verified runtime unit as browser-use 0.13.11, browser-harness 0.1.13 and its locked Chromium. There is no autonomous browser-use model loop or independent updater.
