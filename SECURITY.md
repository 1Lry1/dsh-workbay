# Security Policy

`dsh-workbay` is a family of plugins for DeepSeek Harness (DSH). The plugins
run **inside** the user's DSH desktop process, with that user's privileges, and
they deliberately drive local tools (git, serial ports, vendor flashing
software). This file explains which versions get fixes, how to report a problem
privately, and what the plugins do and do not protect against.

## Supported versions

Only the latest release of each package receives security fixes. The packages
version independently, so a fix may land in one and not the others.

| Package | Version line supported | Notes |
|---|---|---|
| `dsh-workbay-dock` | `0.2.x` | The shell; no host-side command execution |
| `dsh-gitcraft` | `0.1.x` | Spawns `git` against user-selected repositories |
| `dsh-downloader` | `0.1.x` | Serial/COM + vendor Downloader IPC; can flash hardware |
| `@dsh-workbay/kit` | `0.1.x` | Host-only helpers shared by dock and gitcraft |
| `dsh-workbay-suite` | `0.1.x` | Experimental aggregator; no code of its own |

DSH engine ranges are declared per package (`engines.dsh`). An unsupported DSH
version is out of scope: the plugin may load and misbehave in ways we cannot
reason about.

Anything installed from a fork, a modified copy or an untagged snapshot is also
out of scope — this repo cannot vouch for code it did not ship.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a security bug.**
Public disclosure before a fix puts every user of a local-privileged plugin at
risk.

Report privately through GitHub's private vulnerability reporting on this
repository:

- Open the **Security** tab → **Report a vulnerability**, or go directly to
  <https://github.com/1Lry1/dsh-workbay/security/advisories/new>.

Please include:

- the affected package and version (and `@dsh-workbay/kit` if relevant);
- your DSH version and Windows build;
- a minimal reproduction: the repository layout, RPC call or UI steps needed;
- the impact you believe it has, and whether any secret or file was exposed;
- optionally a suggested fix. Redact tokens, credentials, customer/project names
  and absolute local paths from everything you paste.

What to expect: an acknowledgement within about 72 hours, a triage decision with
severity, and a coordinated disclosure — a fix and an advisory (with credit if
you want it) before the details go public. There is no bug bounty.

## Threat model

Scope: the plugins run with the user's own privileges inside DSH. They are an
extension of the desktop app, **not** a sandbox, and they are not a defense
against an attacker who already has code execution or an interactive session as
that user.

**Local HTTP surface, fenced to loopback and same origin.** Each host half
registers an HTTP prefix route on DSH's local web server
(`/dsh-workbay-dock/api`, `/dsh-gitcraft/api`, `/downloader`).
`@dsh-workbay/kit`'s `isTrustedRequest` accepts a request when any of these
holds: the TCP peer is loopback, the `Host` header is loopback, or
`Sec-Fetch-Site` is `same-origin`/`same-site`. This stops a random web page from
driving the plugin through the browser and stops cross-origin form/fetch posts.
It does **not** authenticate a local process: any program running as the same
user that can reach loopback can talk to these routes, by design — the user is
already trusted. There are no bearer tokens or API keys to steal, and the workbench
adds none.

**Local command execution is the feature.** `dsh-gitcraft` spawns the system
`git` binary against the repositories you point it at, including fetch/pull/push
to the remotes configured in those repositories (network egress to git remotes is
therefore expected). Request payloads are validated: refs that look like options
are rejected, `..`-style path traversal and absolute paths are rejected, and an
optional `repoRoot` pins the operation to one repository. Treat a repository
you open with GitCraft as code you chose to trust: hooks, aliases and submodules
run whatever they run.

`dsh-downloader` launches two shipped Win32 helper executables
(`AbSerialHost.exe`, which owns the serial/COM port and the 1.5 Mbps log stream,
and `DownloaderIpcBridge.exe`, a 32-bit bridge used during flashing), and it
drives the vendor Downloader engine on disk. These are privileged, hardware-facing
operations with real-world consequences.

The downloader also registers two DSH **agent tools** (`downloader_list_projects`
and `downloader_logs`), so the model can list project directories and read the
serial log on request. Those results travel wherever DSH sends its conversation —
that is DSH's data path, not a call this repo makes, but it means a serial log may
leave the machine if you ask the agent to read it. Strip device IDs, customer and
project names from logs you hand to the model.

**No telemetry, no hidden egress.** The workbench sends no analytics, crash
reports, update checks or license pings. The only network traffic the plugin code
originates is to git remotes you configured; anything the vendor Downloader engine
does on its own is outside this repository. The plugins do not download or
self-update code.

**Trust boundary for credentials.** Anything in your environment, DSH profile or
shell (tokens, `git` credential helpers, SSH keys) is reachable by the plugin
process because it runs with your privileges. The workbench reads only the
configuration it needs, but it does not isolate you from your own machine.
Never commit or paste such values into issues; see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Hardware warning: the downloader can flash firmware

The downloader page can reflash the firmware of an attached board. Flashing the
wrong image, the wrong target or a wrong port can brick hardware, erase
calibration data, or leave a device in a state that needs a vendor recovery tool.
Check the selected port, chip and firmware before starting a flash, keep other
tools off that COM port, and do not flash unattended or remotely. Firmware is
supplied by you (and by the vendor engine); this repository does not ship or
verify it.

## Out of scope

- Vulnerabilities in DSH itself, the vendor Downloader engine, the CP210x driver
  or Windows — report those upstream.
- Physical damage or data loss caused by flashing an unintended image.
- Attacks that require an already-compromised local account, admin access, or
  the ability to run arbitrary code as the user.
- DoS by a user against their own DSH process (e.g. pointing GitCraft at a
  gigantic repository).
- Feature requests and ordinary bugs — those belong in the issue templates, not
  in a security advisory.

## Hardening recommendations

- Run DSH as a normal user; elevate only when installing serial drivers.
- Install plugins from tagged sources, and review what a profile's `file:`
  dependencies point at before running `pnpm install` there.
- Keep `git` and the vendor Downloader tooling updated; the plugins shell out to
  them.
- Close DSH (and its helper processes) before reinstalling a profile, so a stale
  binary is not left running from an old build.
