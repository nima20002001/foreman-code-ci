# Product

## Register

product

## Users

The primary user is an Operator exploring and managing an agent workspace on a desktop screen. They need to understand agent identity, workflow structure, conversation context, runner health, browser waits, authentication requirements, and interrupted work without confusing mocked frontend state with real execution.

## Product Purpose

Foreman Code is an agent workspace whose UI can use deterministic discovery mocks or a real local workflow engine. The first real slice persists workflow versions and runs, uses LangGraph for orchestration, and executes Product Agents through native headless harnesses while retaining the established frontend contracts and state ownership.

## Brand Personality

Clear, operational, restrained. The interface should feel trustworthy and direct, with information hierarchy and explicit state labels taking priority over visual flourish.

## Anti-references

Do not resemble a marketing site, glossy SaaS dashboard, branded demo, glassmorphic canvas, animated orchestration simulator, or fake terminal. Avoid gradients, decorative motion, ambiguous color-only state, and controls that imply unavailable execution or authentication behavior.

## Design Principles

1. Make state and ownership explicit.
2. Preserve familiar product-workspace affordances.
3. Keep mock behavior visibly separate from real capability.
4. Prefer reversible, understandable interactions with honest failure states.
5. Let the tool disappear behind the Operator's workflow.

## Accessibility & Inclusion

Use semantic controls, visible keyboard focus, readable type and contrast, text labels that do not rely on color, and keyboard-accessible graph selection. Theme switching must expose an accessible name and preserve usable contrast in both themes.
