<div align="center">

# featurekit-mcp

**Change feature flags by asking for it.**

An MCP server for [featurekit](https://github.com/devkitshq/featurekit). Connect it to Claude Code, Claude Desktop, or any MCP client, and roll flags out, turn them off, and check who changed what in plain language.

[![npm version](https://img.shields.io/npm/v/featurekit-mcp.svg?style=flat-square&color=6366f1)](https://www.npmjs.com/package/featurekit-mcp) [![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-339933.svg?style=flat-square)](https://nodejs.org) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)

[featurekit](https://github.com/devkitshq/featurekit) · [Setup](#setup) · [What you can ask](#what-you-can-ask)

</div>

```text
You:   Roll out cart v2 page to 20% of users in production.

Agent: Done. cart-v2-page in production: 20% get true, the rest get
       false. The flag was off; it is now on.

       ⚠ production is a PRODUCTION environment: this change is live
       for real users now.
```

The server found `cart-v2-page` from "cart v2 page", worked out that 20% means a weight of 20,000 out of 100,000, turned the flag on, and said what the flag now serves.

It talks to your control plane's admin API with a personal access token and nothing else. Whatever that token can do with `curl`, the agent can do, and nothing more. Every change it makes lands in the audit log marked `via featurekit-mcp`.

## Setup

You need a running featurekit control plane and Node 20+.

**1. Create a token**

In the dashboard, open **Settings → Personal access tokens**, or call `POST /v1/admin/tokens`. Give the token an expiry and limit it to the environments the agent should touch, so a leaked config can't reach production.

**2. Add the server**

Claude Code:

```bash
claude mcp add featurekit \
  --env FEATUREKIT_URL=https://flags.example.com \
  --env FEATUREKIT_TOKEN=fk_pat_... \
  --env FEATUREKIT_MCP_WRITE=1 \
  -- npx -y featurekit-mcp
```

Claude Desktop, and other clients that read an `mcpServers` config:

```json
{
  "mcpServers": {
    "featurekit": {
      "command": "npx",
      "args": ["-y", "featurekit-mcp"],
      "env": {
        "FEATUREKIT_URL": "https://flags.example.com",
        "FEATUREKIT_TOKEN": "fk_pat_...",
        "FEATUREKIT_MCP_WRITE": "1"
      }
    }
  }
}
```

**3. Ask**

Start with something read-only, like "what flags do we have for checkout?"

### Configuration

| Variable | What it does |
| :-- | :-- |
| `FEATUREKIT_URL` | The control plane. Required. |
| `FEATUREKIT_TOKEN` | A personal access token. Required. |
| `FEATUREKIT_MCP_WRITE` | Set to `1` to allow changes. Without it the server can only read. |
| `FEATUREKIT_PROJECT` | Default project key. You can leave it out when only one project exists. |
| `FEATUREKIT_ENVIRONMENT` | Default environment key. Without it, every change has to name an environment. |

## What you can ask

```text
You:   Bump it to 50%.

Agent: Done. cart-v2-page in production: 50% get true, the rest get
       false. Everyone who had it at 20% still has it.
```

```text
You:   Turn on cart v2 in staging at 10%.

Agent: "cart v2" could mean cart-v2-page or cart-v2-checkout. Which one?
```

```text
You:   Kill cart v2 page in production, checkout is erroring.

Agent: Done. cart-v2-page is off in production. Everyone gets false.
```

| Ask | Tool |
| :-- | :-- |
| "What flags do we have for checkout?" | `find_flags` |
| "What does cart v2 page serve in staging?" | `get_flag` |
| "Roll out cart v2 page to 20% of users" | `set_rollout` |
| "Bump it to 50%" | `set_rollout` |
| "Turn cart v2 on for everyone" | `serve_variation` |
| "Kill cart v2 in production" | `turn_flag_off` |
| "Create a flag for the new search page" | `create_flag` |
| "Only for users in the Netherlands" | `update_flag_config` |
| "Who changed cart v2 last?" | `get_audit_log` |
| "Undo that" | `revert_flag` |

There are also `list_projects`, `list_environments` and `turn_flag_on`.

## How it behaves

When a phrase matches more than one flag, or a change names no environment and no default is set, the tool lists the choices and changes nothing. It won't pick one for you.

Changes to a production environment go through, and the reply warns you in capitals.

Raising a rollout keeps everyone who already had the flag. The new rollout reuses the existing bucketing: the context kind, the attribute, the seed and the order of the variations. Going from 20% to 50% adds 30% of users and leaves the first 20% where they were.

Every write sends the version of the flag the tool just read. If someone edited the flag in between, the API refuses the write and the tool tells the agent to read the flag again and redo the change. Nobody's edit gets silently overwritten.

Targets and rules still apply before a percentage rollout. The rollout covers everyone they don't match, and the reply says so when the flag has any.

## Scope

featurekit-mcp runs over stdio on your machine. There is no hosted endpoint.

Segments, scheduled changes and change requests aren't available as tools yet. Use the dashboard or the admin API for those.

## License

MIT.
