# Nocturne UI

This directory is the canonical shared UI toolkit for the web application. Feature code may import presentation components from `shared/ui/nocturne`; it must keep API contracts, authorization, server state, URL state, and feature mutations in their existing owners.

## Adoption policy

- Import components through `shared/ui/nocturne/index.ts`.
- Keep `legacy-bridge.css` imported once from `main.tsx` while legacy call sites remain.
- Migrate one production surface at a time and retain its behavior tests.
- Do not copy Nocturne components into feature directories or fork their CSS locally.
- Do not use showcase fixtures in production code.
- Style with the design-system tokens in `tokens.css` (`--canvas`, `--text-muted`, `--space-4`, `--radius-md`, `--type-body`, …). Do not add hex colors, off-scale font sizes or radii in feature CSS.

## Design system

The source of truth is the graphql design system in Claude Design: https://claude.ai/artifact/RE7u9oLHtJVKxy7SdmuV91. `tokens.css` is generated from its `project/tokens.json`, and `foundation.css` / `advanced.css` follow its `project/components/bundle.css`. Both dark (default) and light themes are defined there; components never branch on theme. The legacy `--color-*` variables in `styles.css` are aliases of these tokens.

## Provenance

- Bundle: `Nocturne-UI-v2-Toolkit.zip`
- Release: Nocturne UI 2.0
- Bundle SHA-256: `77f3c9c8096c2132ba577f8a775f9cc44219e3a2a6c5a21ba094aeb97427154f`
- Reference repository commit recorded by the bundle: `0d066813f788353218801db245d78e0789b90104`

The bundle checksum and every bundled file checksum were verified before installation. The guarded installer added the toolkit as new files and did not modify dependencies, backend code, Git history, or security configuration.
