# featurekit-mcp

Manage featurekit flags from Claude, or any other MCP client, by asking:

> Roll out cart v2 page to 20% of users in production.

The server finds `cart-v2-page` from the phrase, sets 20% of users to `true`
and everyone else to `false`, turns the flag on if it was off, and replies with
what the flag now serves.

It talks to your control plane's admin API with a personal access token and
nothing else. It can do exactly what that token can do with `curl`, and every
change it makes shows up in the audit log as `via featurekit-mcp`.

## Setup

You need the control plane's URL and a personal access token. Create the token in
the dashboard under **Settings → Personal access tokens**, or with
`POST /v1/admin/tokens`. To keep a leaked config from reaching production, give
it an expiry and limit it to the environments the assistant should touch.

**Claude Code:**

```bash
claude mcp add featurekit \
  --env FEATUREKIT_URL=https://flags.example.com \
  --env FEATUREKIT_TOKEN=fk_pat_... \
  --env FEATUREKIT_MCP_WRITE=1 \
  -- npx -y featurekit-mcp
```

**Claude Desktop**, and other clients that use the same `mcpServers` config:

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

| Variable | |
| :-- | :-- |
| `FEATUREKIT_URL` | The control plane. Required. |
| `FEATUREKIT_TOKEN` | A personal access token. Required. |
| `FEATUREKIT_MCP_WRITE` | `1` to allow changes. Without it the server is read-only. |
| `FEATUREKIT_PROJECT` | Default project key. Optional when only one project exists. |
| `FEATUREKIT_ENVIRONMENT` | Default environment key. Without it, every request has to name one. |

## What you can ask

| Ask | Tool |
| :-- | :-- |
| "What flags do we have for checkout?" | `find_flags` |
| "What does cart v2 page serve in staging?" | `get_flag` |
| "Roll out cart v2 page to 20% of users" | `set_rollout` |
| "Bump it to 50%" | `set_rollout`; everyone already in stays in |
| "Turn cart v2 on for everyone" | `serve_variation` |
| "Kill cart v2 in production, checkout is erroring" | `turn_flag_off` |
| "Create a flag for the new search page" | `create_flag` |
| "Only for users in the Netherlands" | `update_flag_config` (a rule) |
| "Who changed cart v2 last?" / "Undo that" | `get_audit_log`, `revert_flag` |

Also `list_projects`, `list_environments` and `turn_flag_on`.

## How it behaves

- **It never guesses.** If a phrase matches more than one flag ("cart v2" with
  both `cart-v2-page` and `cart-v2-checkout`), or no environment is given and
  no default is set, the tool lists the choices and changes nothing.
- **Production is allowed, and flagged.** A change to an environment marked
  production goes through, and the reply says so in capitals.
- **Raising a rollout keeps everyone already in it.** The rollout reuses the
  existing bucketing (context kind, attribute, seed and variation order), so
  going from 20% to 50% adds 30% of users without reshuffling the first 20%.
- **No change is lost.** Every write sends the version the tool just read, so a
  flag someone else edited in the meantime is refused, not overwritten.
- **Targets and rules still apply first.** A percentage rollout covers everyone
  they don't match, and the reply mentions when the flag has any.

## Limits

- Only stdio. There is no hosted endpoint.
- Segments, scheduled changes and change requests aren't exposed yet. Use the
  dashboard or the API for those.
