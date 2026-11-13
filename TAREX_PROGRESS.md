# Tarex UI — Progress

Last updated: 2026-11-11

## Phase 0 — Baseline and documentation

- [x] Verify repository state and remotes
- [x] Install dependencies
- [x] Record baseline checks
- [x] Create `TAREX_AUDIT.md`
- [x] Create `TAREX_SECURITY_AUDIT.md`
- [x] Create `TAREX.md`
- [x] Create `TAREX_PROGRESS.md`

Baseline results:

- `pnpm check-types`: pass
- `pnpm lint`: warnings only (pre-existing)
- `pnpm test`: 1291 pass, 1 pre-existing Svelte parser failure
- `cargo test`: 383 pass, 1 ignored

## Phase 1 — Identity, import, and branding

- [ ] Product/binary/bundle identity
- [ ] Version 0.1.0
- [ ] Rust crate/lib/CLI rename
- [ ] Env/event/store/keychain rename with compatibility shims
- [ ] New logo, icons, palette, and visible strings
- [ ] Automatic non-secret import
- [ ] Explicit credential import prompt
- [ ] Docs/readme/metadata

## Phase 2 — AI

- [ ] Hydrate built-in provider keys in the main window
- [ ] Built-in models in status-bar and default pickers
- [ ] Open AI without provider gating
- [ ] Fix `runSubagent` compat model handling
- [ ] Restore previous workspace after AI closes
- [ ] `TAREX.md` project memory with `TERAX.md` fallback
- [ ] Tests

## Phase 3 — Process, efficiency, hardware

- [ ] Safe terminate/force-kill process control
- [ ] Protected-process policy and reasons
- [ ] Full process manager UI
- [ ] Resume suspended processes on exit
- [ ] Efficiency Mode
- [ ] Hardware/RAM details with unavailable states
- [ ] Tests

## Phase 4 — Security

- [ ] Path guard for all fs commands
- [ ] Remove home auto-authorization
- [ ] Native picker authorization
- [ ] LSP allowlist
- [ ] Secret service/account allowlist
- [ ] `fs_save_copy` restriction
- [ ] SSRF hardening
- [ ] Opener/asset/CSP tightening
- [ ] Native plan-mode enforcement
- [ ] Tests

## Phase 5 — Release and CI

- [ ] Tarex updater endpoint and signing key
- [ ] Release scripts/tests
- [ ] Remove dead workflows
- [ ] Cross-platform CI
- [ ] Release dry run

## Phase 6 — VPN

- [ ] Document deferred VPN support

## Phase 7 — Final verification and delivery

- [ ] Full checks
- [ ] Smoke tests
- [ ] `requirements.txt` / `.gitignore` review
- [ ] Staged commits
- [ ] Push branch to `tarex` remote
- [ ] Open PR

## Known issues / follow-ups

- Pre-existing Vitest failure in `src/modules/editor/lib/languageResolver.test.ts` (Svelte `IfBlock` expectation).
- `pnpm lint` emits pre-existing warnings; do not introduce new warnings.
- Windows/Linux runtime verification requires CI or external machines.
