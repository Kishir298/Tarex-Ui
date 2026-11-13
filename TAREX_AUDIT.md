# Tarex UI — Repository Audit

Date: 2026-11-11
Base commit: `49a799b` (Terex UI upstream)
Audit scope: identity, AI activation, process management, dashboard/hardware, VPN, security, release infrastructure, cross-platform support.

## Summary

The repository is a complete Tauri 2 + React 19 terminal/editor application. It is still the Terex UI product with internal `terax` identifiers. The AI subsystem, process dashboard, release pipeline, and storage paths are tightly coupled to the old identity. Several correctness and security issues were confirmed.

## Identity and storage

- `src-tauri/tauri.conf.json` uses `Terex UI`, `terex-ui`, `io.github.3xecutablefile.terex-ui`, version `0.10.0`.
- Rust package/library/crates use `terax`, `terax_lib`, `terax-cli`, `terax-control-protocol`.
- Settings store is `terax-settings.json`; AI stores, spaces, and custom themes use `terax-*.json`.
- Keychain service is `terax-ai`.
- `src-tauri/src/modules/shared_storage.rs` intentionally reuses `app.crynta.terax` when that directory contains `terax-settings.json`.
- The updater endpoint and release workflows target `3xecutablefile/terex-ui`.
- User-visible strings, icons, window titles, installer hooks, and docs still reference Terex/Terax.

## AI activation and provider support

- `src/modules/ai/hooks/useAiBootstrap.ts` computes `hasComposer` only from custom endpoints and never loads built-in provider keys. `getAllKeys()` is only called from `ModelsSection.tsx`.
- `App.tsx` uses `hasComposer` to redirect `ai.toggle`, `ai.askSelection`, attach-file, and mini-window actions to Settings → Models instead of opening the AI panel.
- `AiStatusBarControls.tsx` and `ModelsSection.tsx` build their model lists from custom endpoints only, so built-in provider models are absent from the chat picker and default-model picker.
- `runSubagent.ts` calls `getModel(modelId as ModelId)` and throws for custom-endpoint (`compat-*`) IDs.
- `Desktop.tsx` sets `fileMode=false` when AI opens but does not restore the previous workspace state when AI closes.
- `readTeraxMd()` reads a project memory file named `TERAX.md`; Tarex should read `TAREX.md` with an optional legacy fallback.

## Process management

- `src-tauri/src/modules/process_control.rs` only supports suspend/resume and hard kill (`SIGKILL`/`TerminateProcess`).
- Protection is limited to PID <= 1, self, invalid PIDs, and PID-reuse checks. Ancestors, critical system processes, and the app's own process tree are not protected.
- `Processes.tsx` is a compact PID/name/CPU table with no memory column, search, sorting, or protected-process reasons.
- Suspended processes are persisted and not resumed on app exit.
- `dashboard.rs` truncates the process list to five entries.
- There is no Efficiency Mode.

## Hardware and system visibility

- `dashboard.rs` reports hostname, OS, kernel, architecture, uptime, CPU name/usage, memory totals, swap, top processes, and disks.
- RAM module type/speed/slot count is unavailable.
- No hardware details view exists.
- No VPN/wireguard/openvpn implementation or UI exists.

## Security issues

See `TAREX_SECURITY_AUDIT.md` for severity and remediation details. Key findings:

- `fs_read_file`, `fs_write_file`, `fs_stat`, and `fs_canonicalize` do not consult the workspace registry.
- Home is automatically authorized at startup.
- `workspace_authorize` accepts arbitrary renderer-supplied paths.
- `lsp_spawn` accepts arbitrary command, args, and environment.
- `fs_save_copy` can read an arbitrary source and write to an arbitrary destination.
- Secret commands accept arbitrary service/account names.
- Opener path capability and asset protocol scope are `**`.
- CSP permits broad network and frame sources.
- Plan mode is enforced by prompt text, not by native write/spawn guards.

## Release and cross-platform

- `release.yml`, `release.mjs`, and `release.check.mjs` use Terex names, `TEREX_RELEASE_VERSION`, `TERAX_CLI_TARGET`, and Terex artifact names.
- Updater signing requires the upstream private key and the endpoint points at upstream.
- Dead workflows exist: `signpath-test.yml`, `update-nix-sources.yml`.
- Windows installer hooks reference `terax.exe`; this must match the new `tarex-ui` binary.
- No local Windows/Linux runtime verification is possible in this environment; CI and cross-platform compile checks are required.

## Decisions

- Product: Tarex UI
- Binary: `tarex-ui`
- Bundle identifier: `io.github.kishir298.tarex-ui`
- Internal crate/env/event prefix: `tarex`/`TAREX_`
- CLI: `tarex`
- Initial version: `0.1.0`
- Repository: `https://github.com/Kishir298/Tarex-Ui`
- Remote policy: add `tarex` remote; keep `origin` as upstream.
- Updater: new Tarex signing keypair; public key committed, private key stored as a repository secret.
- Import: automatic non-secret Terex/Terax data import on first launch; explicit prompt before importing API keys.
- VPN: deferred and documented.
- Rename: full internal rename with narrow compatibility shims.

## Baseline check results

- `pnpm check-types`: pass.
- `pnpm lint`: warnings only (pre-existing), no errors.
- `pnpm test`: 1291 passed, 1 pre-existing failure in `languageResolver.test.ts` (Svelte parser expected `IfBlock`).
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: 383 passed, 1 ignored.

## Follow-up

Implementation is tracked in `TAREX_PROGRESS.md`; security remediation is tracked in `TAREX_SECURITY_AUDIT.md`.
