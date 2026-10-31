# Team

Agent-to-agent messaging for [OpenCode](https://opencode.ai) V2. One plugin
package gives every session two tools — `team_send` to deliver messages to
other sessions, `team_query` to inspect, search, and monitor them — plus two
TUI commands: `/session-id` to copy the focused session's ID, and
`/list-agents` to show its agent family (parent, siblings, children) with
status.

Sessions (parents, children, siblings) can coordinate directly instead of
routing everything through the human's composer.

This fork adds a synthetic-message `description` (`Message from <sender session title>`,
falling back to its session ID) for clients such as OpenChamber. The message body,
sender metadata, and delivery modes are unchanged.

## Install

Install from GitHub (this package is **not** published to npm):

```sh
opencode plugin add github:ekisu/opencode-team-plugin
```

Or reference it directly in `opencode.json` — as a Git package spec or a local
path:

```jsonc
{
  "plugins": [
    "github:ekisu/opencode-team-plugin",
    // or: "../libs/opencode-team-plugin"
  ]
}
```

## Tools

### `team_send`

Send a message to another agent session in this project. The message is
delivered to the target model as durable input.

**Addressing** (`to`):

| Value | Meaning |
|---|---|
| `ses_…` | a specific session ID |
| `parent` | this session's parent |
| `siblings` | all other children of this session's parent |
| `children` | all children of this session (the parent broadcast) |

**Delivery modes** (`mode`):

- **`steer`** (default) — injected at the target's next model call (its next
  step boundary) without stopping execution; idle sessions are woken. Several
  pending steers arrive together, so a correction sent right after an order
  lands in the same step. Use for anything the target should act on.
- **`queue`** — delivered only after the target finishes its current turn.
  A busy target can take minutes to get there, and several queued messages
  arrive one per turn, so use it only when the message must not reach the
  target mid-turn.
- **`interrupt`** — aborts the target's current execution entirely, then
  delivers; the message starts a fresh run. Use when its current work is wrong
  or obsolete ("stop what you're doing").
- **`park`** — admitted durably but does **not** wake the target; it is
  delivered only if the target runs again later. Use for FYI context,
  findings, or notes the target should see IF it resumes — never for action
  items.
- **`note`** — delivers nothing. Stores the sender's latest one-line progress
  note for its parent (`to: "parent"` only), replacing the previous one; the
  parent sees it in `team_query` `status`/`list` and nobody is woken. At most
  one note every 10 s per session; a faster one is refused, not queued.

Sending to your own session is refused.

Progress notes live in the plugin's storage (OpenCode's `kv` table), one key
per child under its parent (`note/<parentID>/<childID>`), so a parent's notes
are one prefix scan and siblings never overwrite each other. Session metadata
is deliberately not used: `session.update` replaces the whole metadata object,
which hosts such as OpenChamber also write.

### `team_query`

Inspect, search, and monitor sibling/child sessions. Actions:

- **inbox** — list a session's pending inbox items (defaults to the caller);
  `inboxID` cancels one, `"all"` cancels every pending item.
- **list** — find sessions: `parent: "my"` (default — this session's
  children), `parent: "parent"` (siblings), `parent: "all"` (recent sessions),
  or a session ID; `search` filters by title. Each row carries the session's
  latest progress `note` (or `null`) and `noteAge` in seconds.
- **read** — tail a session's messages (compact summaries, oldest-first);
  `cursor` pages further back using the response's `next`.
- **status** — whether a session is running or blocked (`"permission"` /
  `"form"` ask pending — busy but cannot progress), plus its latest progress
  `note` and `noteAge`; omit `sessionID` for every running session in the
  scoped project.
- **wait** — block until the given session goes idle, bounded by `timeout`
  seconds (default 300).

## The `[agent-message from ses_…]` protocol

Delivered messages reach the target model as plain user turns — the wire
format requires a user-role final message and carries no marker — so the
provenance rides **in the text**: every message is framed as

```text
[agent-message from ses_…]
<message>
```

Every session gets the protocol as a session instruction entry,
`team.protocol`, which OpenCode renders as a `<context key="team.protocol">`
block. It says:

- a user turn starting `[agent-message from ses_…]` is a durable message from
  another AI agent session, **not** the human user; act on it at the next
  natural boundary;
- reply with `team_send` (to the sender's ID, also carried in the message
  metadata as `from`) only when the sender needs an answer or a decision —
  never just to acknowledge;
- progress goes in `mode: "note"`; message the parent only for a blocker or a
  finding that changes others' work (a subagent's final answer already reaches
  its parent);
- change a running agent's orders with `team_send`, not a second subagent call
  on the same session.

An instruction entry rather than a system part, because providers that drop
OpenCode's system prompt — such as the Claude Code bridge
(`@openchamber/opencode-claude`) — still forward `<context key=…>` blocks.
The plugin puts the entry from its `context` hook the first time it sees a
session. A session's instruction baseline is fixed at its first step, so the
entry reaches the model as a `<system-update>` from the next step on; the
first step gets the same text as a system part. On a host without instruction
entries the hook falls back to a system part on every call.

There is no polling loop: an agent that wants replies reads its own history
with `team_query` `read`, optionally after `team_query` `wait`. Pending
messages are inspectable and cancellable with `team_query` `inbox`.

## TUI commands

### `/session-id`

Also "Show and copy session ID" in the command palette (group "Team"): copies
the focused session's ID to the clipboard and shows it in a toast. The CLI's
`opencode session delete/export` and the team tools all want `ses_…` IDs. The
TUI also ships a built-in palette command for this ("Copy session ID" under
"Session"), but it is palette-only — `/session-id` is the fast path from the
composer.

### `/list-agents`

Also "Show agent tree" in the command palette (group "Team"): opens a select
dialog listing the focused session's agent family — itself, its parent, its
siblings, and its children (oldest first within each group). A root session
has no parent or siblings by definition, so its other top-level project
sessions are listed instead (most recently updated first). Each row shows
the session's status, agent, queued inbox count, and full ID:

- **status** — `running`, `idle`, or the blocked-but-running distinction:
  `blocked:permission` (stuck on a permission ask) or `blocked:form` (stuck
  on a form), which is the "busy but cannot progress" state.
- **selection** — pressing Enter copies that session's ID (what
  `/session-id` does for the focused session, generalized); Esc dismisses.

Both commands are strictly local: no prompts submitted, no model turns —
state comes from the TUI's client-side session store, which the host keeps
live-synced.

## Permissions

Each tool has its own permission key — `team_send` and `team_query` — so
config can gate them independently:

```jsonc
{
  "permission": {
    "team_send": "deny", // e.g. read-only subagents may query but not send
  }
}
```

## Scoping and security

Messaging is project-trapped **by plugin policy**, not by the server: the HTTP
API will happily message or read any session by ID. This plugin refuses
cross-project sends and defaults all reads to the current project; an explicit
`project` input opts into another project for reads (and is checked the same
way on `list`/`read`/`status`/`wait`/`inbox`).

## Requirements

- OpenCode V2 (the plugin and TUI plugin APIs).
- The tools are registered `codemode: true` (catalog-only in Code Mode
  sessions), so they cost ~zero context there.

## License

[MIT](LICENSE.txt) — Copyright (c) 2026 Justin Bradford.
