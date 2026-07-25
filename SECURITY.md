# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | Yes       |
| 1.x     | No        |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please report them privately using one of the following methods:

### 1. GitHub Private Vulnerability Reporting (preferred)

Use GitHub's built-in private reporting:

**[Report a vulnerability](https://github.com/I4cTime/mineui/security/advisories/new)**

### 2. Email

Send details to the maintainer directly. You can find contact information on the [@I4cTime GitHub profile](https://github.com/I4cTime).

## What to Include

When reporting, please provide:

- **Description** of the vulnerability and its potential impact.
- **Steps to reproduce** or a proof of concept.
- **Affected version(s)** of MineUI.
- **Environment** details (OS, mode — Simple/Advanced, container runtime and version if applicable).
- **Suggested fix**, if you have one.

## Response Timeline

| Stage | Timeframe |
|-------|-----------|
| Acknowledgement | Within 48 hours |
| Initial assessment | Within 7 days |
| Fix or mitigation | Varies by severity |
| Public disclosure | After a fix is released |

## Scope

The following areas are in scope for security reports:

- **Subprocess execution** — command injection via Docker/Podman CLI calls,
  the managed Java process (Simple mode), or any other shell-out. All
  subprocess calls must build an argv array; shell-string interpolation is
  a reportable bug (see `CONTRIBUTING.md` § Scope boundaries).
- **Server jar download and verification** — bypass or weakening of the
  SHA-1 verification MineUI performs before running an official Minecraft
  server jar in Simple mode.
- **RCON console** — command injection or allowlist bypass in the RCON
  command panel.
- **Mods & Plugins** — path traversal or unsafe file handling in upload,
  URL download, or delete flows.
- **Configuration editor** — path traversal outside the intended
  `server.properties` / `config/` scope.
- **World backups** — path traversal or archive extraction issues
  (zip-slip style) in backup create/restore.
- **Tauri IPC surface** — any command reachable from the frontend that
  bypasses intended capability/permission scoping in
  `src-tauri/capabilities/`, or a mismatch between `docs/v2-contract.md`
  and the actual IPC implementation that grants excess access.
- **Container attachment (Advanced mode)** — unauthorized access to a
  container's filesystem or Docker/Podman socket beyond the attached
  server.
- **Secrets and credentials** — RCON passwords or other locally stored
  credentials leaking to logs, disk in plaintext where avoidable, or the
  frontend bundle.

## Out of Scope

- Vulnerabilities in upstream dependencies (report those to the respective project).
- Vulnerabilities in the Minecraft server jar itself, or third-party mods/plugins you choose to run.
- Issues requiring physical access to an already-unlocked machine.
- Social engineering attacks.

## Recognition

We're happy to credit security researchers in the release notes and CHANGELOG unless you prefer to remain anonymous. Let us know your preference when reporting.
