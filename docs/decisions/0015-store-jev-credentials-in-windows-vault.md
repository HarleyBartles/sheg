# ADR-0015: Store Jev credentials in Windows Credential Manager

- Status: Accepted
- Date: 2026-09-30
- Supersedes: None

## Context

Users need a secure local way to supply OpenRouter or TypeSafe keys without
putting secrets in study files, chats, command arguments, or plaintext
environment variables. This release can be verified on Windows.

## Options considered

- Read keys from environment variables, which encourages plaintext process
  configuration and creates a fallback path.
- Add a cross-platform vault abstraction immediately, although macOS and Linux
  behavior cannot be verified in this slice.
- Support Windows Credential Manager with explicit future work for other OSes.

## Decision

Use fixed per-route Windows Credential Manager targets. Provide an interactive
helper that accepts hidden input locally for setup and removal. Provider code
reads only the selected vault target. Do not support environment key sources
or fallback. macOS Keychain and Linux Secret Service remain future work.

## Consequences

Setup is local and secure by default on Windows. Unsupported platforms report
vault unavailability. A missing or unreadable selected entry fails before a
provider request; users can still defer connecting a key until a hosted run.
