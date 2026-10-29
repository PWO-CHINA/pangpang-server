---
name: backend
description: Check and quickly switch your own model backend (Xiaomi MiMo flash/pro, optional DeepSeek or relay models, or the smart pool), its pool order, and thinking level, with the backend tool. Use when the owner asks to change model, when a task needs a stronger or cheaper model, or when a provider is failing.
---

# Switching your own backend

You run on a model pool by default: `alias/main`, the chain in `agent/model-alias.json`.
Each call tries the chain in order, reordered live by health and speed, and fails over to
the next target before any output if one errors or stalls. Cooling-down targets go last.

Everything goes through the `backend` tool:

| action | what it does | lasts |
|---|---|---|
| `status` | this chat's model, thinking, defaults, pool chain with health, available models | - |
| `use model:"deepseek/deepseek-v4-pro"` | this chat switches to one fixed model (no failover) | until switched back or `/new` |
| `use model:"pool"` | back to the pool | - |
| `use ... persist:true` | also the default for new sessions and after restarts | permanent |
| `pool chain:[...]` | set the pool order, preferred first | permanent, next call |
| `thinking level:"high"` | thinking level for this chat | this session |

The owner can do the same with `/model` (`/model list`, `/model pool`, `/model provider/id`)
and `/think`.

## Backends

- `deepseek/deepseek-flash`: default. Cheap and fast; everyday chat, tool use, coordination.
- `xiaomi/mimo-v2.6-pro`: stronger reasoning; first fallback. `xiaomi/mimo-v2.6-flash` and
  `xiaomi/mimo-v2.5-pro` follow.
- `deepseek/deepseek-v4-pro`: stronger DeepSeek model, not in the pool; use it on demand.
- Heavy multi-step engineering is not a reason to switch: delegate it (delegation skill).

## When to switch

1. The owner asks ("换 pro", "用 mimo"): do it at once with `use`. Ask whether it should
   stick only if they say "默认" / "以后都" (then `persist:true`); otherwise it is for this
   chat only. Confirm in one line which model is now active.
2. A hard reasoning step that flash keeps getting wrong: switch to `xiaomi/mimo-v2.6-pro`
   or `deepseek/deepseek-v4-pro` for it, then `use model:"pool"` when done. Tell the owner.
3. A provider keeps failing (`status` shows low success): the pool already fails over. Only
   if the owner wants a lasting change, reorder with `pool`, keeping every working target in
   the chain so failover still has somewhere to go.

## Rules

- Prefer the pool. A fixed model has no failover: if it breaks mid-task the turn fails.
- Never put `alias/main` into its own chain, and never leave the chain with one target.
- A persistent change (`persist`, `pool`) edits files in this repo: say so, and it is
  committed with your other growth. Mention it to the owner.
- Do not switch to save money on a single message; flash is already the cheapest.
- Changes take effect from the next model call, not in the middle of the current one.
