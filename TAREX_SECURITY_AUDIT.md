# Tarex UI — Security Audit and Remediation

Date: 2026-11-11
Status: findings confirmed; remediation in progress.

## Threat model

Tarex is a local desktop terminal, editor, and AI agent. The primary untrusted inputs are:

- Model output and prompt-injected content that drives agent tools.
- Project files, repository names, terminal output, and web content shown in the UI.
- Renderer content if a remote URL or crafted asset ever enters the webview.
- Legacy Terex data imported on first launch.

The security boundary must not rely on UI text or prompt instructions. Native commands must enforce path, process, secret, and command constraints.

## Findings and fixes

### Critical / High

1. **Unrestricted filesystem reads and writes**
   - Finding: `fs_read_file`, `fs_write_file`, `fs_stat`, and `fs_canonicalize` resolve paths without checking `WorkspaceRegistry`.
   - Impact: a compromised renderer or prompt-injected tool can read/write outside the active workspace.
   - Fix: require a `PathAccess` guard for all filesystem commands. Agent tools use an explicit workspace-only scope. UI paths are authorized by native pickers, workspace roots, or explicit user confirmation.
   - Status: planned.

2. **Home directory automatically authorized**
   - Finding: `bootstrap_registry` authorizes the home directory on every launch.
   - Impact: the workspace boundary is effectively the entire home directory.
   - Fix: remove automatic home authorization. Authorize only the launch workspace and explicitly selected paths.
   - Status: planned.

3. **Renderer can authorize arbitrary paths**
   - Finding: `workspace_authorize(path)` trusts any renderer-supplied path.
   - Impact: an XSS or compromised renderer can expand its own access.
   - Fix: add native folder/file picker commands that return one-time authorization tokens; `workspace_authorize` only accepts a path proven to come from a native picker or an explicit user confirmation flow.
   - Status: planned.

4. **Arbitrary LSP process execution**
   - Finding: `lsp_spawn` accepts command, args, env, and root from the renderer.
   - Impact: arbitrary local code execution.
   - Fix: allowlist known LSP commands and arguments; restrict environment keys; require the root to be an authorized workspace; reject shells and interpreter `-e` forms.
   - Status: planned.

5. **Arbitrary copy source/destination**
   - Finding: `fs_save_copy` copies any readable source to any absolute destination.
   - Impact: exfiltration of sensitive files through a user-visible save dialog.
   - Fix: source must be authorized; destination must come from a native save dialog. Never follow symlinks outside the authorized source.
   - Status: planned.

6. **Unscoped secret access**
   - Finding: `secrets_get`, `secrets_set`, `secrets_delete`, and `secrets_get_all` accept arbitrary service/account names.
   - Impact: a compromised renderer can read other applications' keychain entries.
   - Fix: restrict service to `tarex-ai` and accounts to a known provider/endpoint allowlist. Add explicit legacy credential import command for the old `terax-ai` service.
   - Status: planned.

7. **Plan mode enforced only by prompt**
   - Finding: plan mode adds prompt text; native writes/spawns are not blocked.
   - Impact: a model can ignore the prompt and mutate the workspace.
   - Fix: store plan mode state natively. Reject mutating agent commands and process spawns while plan mode is active unless a user-approved diff is applied.
   - Status: planned.

### Medium

8. **Broad opener capability**
   - Finding: `opener:allow-open-path` allows `**`.
   - Impact: opening arbitrary paths/executables from renderer content.
   - Fix: remove the broad permission. Add a native `open_path` command that validates the path against authorized files and known safe operations, or use opener URL-only permissions.
   - Status: planned.

9. **Broad asset protocol scope**
   - Finding: asset protocol scope is `**`.
   - Impact: renderer can load arbitrary local files as images/media.
   - Fix: add a custom asset protocol or validate paths against the path registry; restrict scope to app cache/assets where possible.
   - Status: planned.

10. **CSP too broad**
    - Finding: `connect-src` allows all `https:` and localhost; `frame-src` allows `http:`/`https:`.
    - Impact: increased exfiltration and framing surface.
    - Fix: keep only required provider endpoints and local preview origins; use an allowlist for frames and document preview needs.
    - Status: planned.

11. **SSRF edge cases in local proxy**
    - Finding: audit identified IPv4-mapped IPv6 and metadata/link-local gaps.
    - Impact: local proxy could reach unintended local services.
    - Fix: normalize IPs, block IPv4-mapped IPv6, loopback, link-local, unique-local, unspecified, and cloud metadata ranges. Resolve DNS and re-check before connect. Add tests.
    - Status: planned.

12. **Legacy import risks**
    - Finding: automatic import can carry command-bearing settings and stale process state.
    - Impact: imported commands or suspended PIDs could be activated unexpectedly.
    - Fix: import only known non-secret files; skip `suspended-processes.json`, `secrets.json`, and window state; reject symlinks; validate JSON; flag imported LSP/formatter/agent commands for review; subject them to new allowlists.
    - Status: planned.

### Low

13. **Verbose diagnostics**
    - Finding: process paths/names can be logged in debug output.
    - Fix: keep logs user-local and avoid logging secrets, full environment, or credential values.

## Verification plan

- Rust unit tests for path escapes, symlink escapes, LSP allowlists, secret allowlists, SSRF ranges, and plan-mode rejection.
- Vitest tests for AI tool scope and activation behavior.
- Manual macOS smoke test; CI compile/test on Linux and Windows.
- Re-run `pnpm check-types`, `pnpm lint`, `pnpm test`, `cargo test`, `cargo clippy -- -D warnings`.

## Residual risks

- The webview renderer remains a trusted UI surface for user-initiated actions. The goal is to prevent prompt-injected model tools and remote content from bypassing native constraints.
- Hardware details may require platform commands; these are fixed-argument, read-only, and never accept model/user input.
- Legacy API key import is explicit and user-confirmed; keys must never be logged.
