# dsh-intranet-browser
Bypasses the SSRF protection of @yeesy369dsh-browser-playwright

[中文](https://github.com/Short-Arm-Ape/dsh-intranet-browser/blob/main/%E8%AF%B4%E6%98%8E%20.md)

# Overview

This plugin is modified by @yeesy369/dsh-browser-playwright and relies on the upstream plugin [@xylt369/dsh-browser](https://github.com/xylt369/dsh-browser/).

This plugin will **⚠️bypass the SSRF protection** of the original plugin (`url-guard. ts`) to facilitate DeepSeek Harness to open local and LAN for page debugging.It will invoke an independent Playwright instance (independent service name, independent profile directory, independent window). 

For security reasons, **every `intranet_*` tool call is gated behind user approval** (default `approvalMode: 'per-call'`), and cloud-metadata endpoints stay blocked by default.

# Relationship to the original plugins

| Package name    | Original plugin `browser-playwright` | This plugin `intranet-browser`                               |
| --------------- | ----------------------------- | ------------------------------------------------------------ |
| Service name    | `ctx.browser`                 | `intranet-browser` (separate instance)                       |
| SSRF protection | Strict url-guard, untouched   | Bypassed (metadata block retained)                           |
| Browser window  | Own Edge profile              | **Another** profile (default `~/.dsh/intranet-edge-profile`) |
| Tool names      | `browser_*`                   | `intranet_*`                                                 |
| Approval        | via `web-permission`          | Built-in `ctx.approval` gate (per call)                      |

The two browsers can run side by side.

# Dependency and adaptation version

| Name | Version |
|---------|---------|
| [`xylt369/dsh-browser`](https://github.com/xylt369/dsh-browser/) | `0.8.1` |
| [`DeepSeek Harness`](https://github.com/deepseek-ai/deepseek-harness) | `0.1.0-rc.7` |

# Development & Quick start

## 1.Install [xylt369/dsh-browser](https://github.com/xylt369/dsh-browser/blob/main/README.en.md#install)

## 2.Download source code & Build the package

Execute in [absolute path to this package]:
```sh
pnpm install
```
If you want to conduct a test:

```sh
pnpm --filter Short-Arm-Ape/dsh-intranet-browser build
pnpm --filter Short-Arm-Ape/dsh-intranet-browser typecheck
pnpm --filter Short-Arm-Ape/dsh-intranet-browser test
```

Unit tests cover the URL policy (metadata block, file/credentials/scheme checks) and the approval-gate decision logic; real-browser behavior can be verified following `browser-playwright`'s e2e pattern.

## 3.Add to DeepSeek Harness:

```sh
dsh plugin --profile web add [absolute path to this package]
```

If there is a running DeepSeek Harness instance, restart it.

The AI calls `intranet_open`; an approval prompt appears (per call by default); only after you approve does navigation happen. Then keep debugging with `intranet_snapshot` / `intranet_click` / `intranet_screenshot` …

# Tools

| Tool | Purpose |
| --- | --- |
| `intranet_open` | Open an http(s) (optionally file) URL; localhost/LAN/private addresses allowed |
| `intranet_snapshot` | Accessibility snapshot of the current page (with refs) |
| `intranet_screenshot` | Screenshot as a durable image attachment (vision-model ready) |
| `intranet_click` / `intranet_type` / `intranet_fill` / `intranet_press` | Page interaction |
| `intranet_scroll` / `intranet_wait` | Scrolling and bounded waits |
| `intranet_back` / `intranet_forward` | History navigation |
| `intranet_close` | Close the intranet browser window (releases the profile lock) |
| `intranet_arm` / `intranet_disarm` | Only meaningful under `approvalMode: 'arm'`: approve once to activate / deactivate |

# Config

`$DSH_HOME/settings.yaml` (hot-reload; also editable under **Settings → Plugin config → Intranet browser** for `approvalMode` / `blockMetadata` / `windowVisibility` / `stealth`; the rest stays YAML):

```yaml
intranet-browser:
  approvalMode: per-call   # per-call (default, prompt every time) | arm (no prompts after intranet_arm)
  blockMetadata: true      # keep blocking cloud metadata (169.254.169.254 / metadata.google.internal / instance-data …)
  blockedHostnames: []     # extra hostnames/IPs always blocked
  allowFile: false         # allow file:// URLs
  windowVisibility: visible # visible (default) / hidden / headless — applies on next browser launch
  stealth: true            # lightweight anti-detection
  channel: null            # chrome / msedge, auto-detected when omitted
  profileDir: ~/.dsh/intranet-edge-profile
  maxWaitMs: 60000
```

# Semantics & limitations

- **The only checks left are**: scheme must be http(s) (plus file when `allowFile`), no embedded credentials (`user:pass@`), and the metadata blocklist by default. **Private-IP / loopback / DNS-resolved screening is gone** — that is the point.
- **Approval is the last gate**: in the `tools/pre-execute` waterfall, any `intranet_*` call that is not approved is denied (fail-closed). Calls also fail when there is no approval service or no agent.
- **Full-access sessions auto-pass**: when the CALLING session's approval policy is `never` (the Full access / danger-full-access preset), `intranet_*` calls pass without prompting — the user already opted out of approval prompts at the session level, matching the trust level of shell / file tools. Switching back to `ask` (e.g. `/permission workspace-write`) restores per-call prompts.
- **Arm mode** disables prompts only for the **current agent**, for the process lifetime; a dsh restart requires `intranet_arm` again.
- **Metadata stays blocked by default**; do not disable `blockMetadata` outside networks you fully control (e.g. a cloud VM explicitly testing IMDS).
- Each navigation returns `url / title / statusCode` like the `browser_*` tools.
- Tabs are isolated per harness session; cookies share the standalone profile (persistent logins).

# Model Experience

- The model sees the `intranet_*` tools (descriptions carry the SSRF-bypass + approval notice) plus page text/refs/screenshot attachments; it never sees Playwright or browser internals.
- Under the `ask` policy every `intranet_*` call may trigger an approval prompt; the descriptions tell the model not to spam and to state intent first. Under `never` (Full access) no prompts appear.
- Long snapshots cost tokens; screenshots travel as attachments, not base64.
- `intranet_open` returns the final URL, title and HTTP status code for troubleshooting.
