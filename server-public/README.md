# pangpang public source

A TypeScript agent built on the pi SDK, with Telegram and Weixin clients, local memory, scheduled tasks, recall, model routing and optional Caveman compression. This is a source-only starting point for testing and further development; it contains no original conversations, personal memory, task data, credentials, backup files or Git history.

## Setup

The supplied bootstrap and service scripts target Linux. On Linux, restore executable permissions with `chmod +x bootstrap.sh bin/pp`, install the toolchain with `./bootstrap.sh`, then copy `.env.example` to `.env` and fill in your own credentials. Copy each `agent/*.example` file to the same name without `.example` and edit it for your own environment. These local configuration files are ignored by Git. Reviewed, sanitized skills are included; personal memories and external delegation configuration are excluded. Configure integrations for your own environment.

Load the environment with direnv and run `pp check`. For the offline smoke test, use a fresh scratch directory on each run:

```bash
mkdir -p var/tmp
PP_VAR="$(mktemp -d "$PWD/var/tmp/smoke.XXXXXX")" node --disable-warning=ExperimentalWarning test/smoke.ts
node --disable-warning=ExperimentalWarning --test test/public-mode.test.mjs
node --disable-warning=ExperimentalWarning test/notification-pool.ts
node --disable-warning=ExperimentalWarning test/notification-content.ts
node --disable-warning=ExperimentalWarning test/alias-thinking.ts
node --disable-warning=ExperimentalWarning test/weixin-contract.ts
node --disable-warning=ExperimentalWarning test/weixin-inbound.ts
```

The smoke test requires the Linux toolchain from `environment.yml`, including `bash` and `jq`. `pp up` starts the service after configuration; use independent credentials for any test instance.

## Clients and notifications

Telegram and the optional Weixin client keep separate conversation contexts while sharing memory, skills and recall. Replies and attachments for a direct turn go to the originating chat. Automation uses separate background sessions and routes notifications through the notification pool. Background notifications use final assistant text only; model reasoning from an incompatible or unidentified source is removed from request history instead of being converted to visible text.

After configuring the application, run `pp weixin login` to bind your own account and `pp weixin status` to check it. The integration wraps Tencent's published `@tencent-weixin/openclaw-weixin` package and the OpenClaw SDK; it does not run an OpenClaw Gateway. Exact compatible versions are pinned in the manifest and lockfile. The wrapper needs Node with `node:module.registerHooks`; use the Node 22 toolchain installed by `bootstrap.sh` (22.15 or later). Credentials and upstream state are stored under the ignored `var/weixin/` directory.

`/notify` displays the pool status. By default it prefers the most recently used authorized client and falls back to the other on failure; `/notify broadcast on` sends to both available clients, and `/notify broadcast off` restores failover. Telegram notifications use `PP_NOTIFY_CHAT` when set, otherwise the first allowed user; Weixin notifications use the bound account's private chat. Tasks may select a channel or an explicit recipient. Pending deliveries and progress are kept in private runtime storage and retried without rerunning the underlying task. A timeout can leave delivery uncertain, so retries or failover may result in duplicate messages; confirmed sent segments are checkpointed.

The notification pool settings, outbox, delivery metadata, login QR and channel credentials are private. Never commit or publish them. See `src/channels/`, `src/conversation.ts`, `src/automation/`, and the offline tests for integration contracts.

## Synthetic fixtures

[`examples/`](examples/) contains fictional chats, memories, and a disabled task for experimentation. They are not loaded by the service automatically.

## Privacy and development

`data/`, `var/`, `agent/memory/`, new untracked `agent/skills/`, agent configuration and `.env` are ignored; the previously reviewed skill files remain tracked. The original automatic Git commit and push of private data has been disabled. Review changes before committing, and do not force-add ignored content. The top-level workspace `.gitignore` also excludes the original private snapshot, keys and archives.

The project includes third-party code; see `LICENSE`, `NOTICE` and `src/pool/LICENSE`.

## Testing and deployment

Use the synthetic fixtures and dedicated test credentials in development. Never reuse a production Telegram token for a simultaneous polling instance. Set up production separately using its own `.env` and `agent/` configuration, and keep its persistent `data/`, `var/` and `agent/memory/` outside the public repository with appropriate private backups. No credentials or data are included in the release.

The bootstrap downloads and builds third-party dependencies and requires network access. The bundled CLI and service scripts target Linux; Windows is useful for source editing, but is not a validated deployment platform. Review settings and run offline checks before enabling integrations or scheduling tasks.
