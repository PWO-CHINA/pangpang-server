# pangpang public source

A TypeScript Telegram agent built on the pi SDK, with local memory, scheduled tasks, recall, model routing and optional Caveman compression. This is a source-only starting point for testing and further development; it contains no original conversations, personal memory, task data, credentials, backup files or Git history.

## Setup

The supplied bootstrap and service scripts target Linux. On Linux, restore executable permissions with `chmod +x bootstrap.sh bin/pp`, install the toolchain with `./bootstrap.sh`, then copy `.env.example` to `.env` and fill in your own credentials. Copy each `agent/*.example` file to the same name without `.example` and edit it for your own environment. These local configuration files are ignored by Git. The original personal skills and external delegation configuration are excluded; configure or create your own if needed.

Load the environment with direnv and run `pp check`. For the offline smoke test, use a fresh scratch directory on each run:

```bash
mkdir -p var/tmp
PP_VAR="$(mktemp -d "$PWD/var/tmp/smoke.XXXXXX")" node --disable-warning=ExperimentalWarning test/smoke.ts
node --disable-warning=ExperimentalWarning --test test/public-mode.test.mjs
```

The smoke test requires the Linux toolchain from `environment.yml`, including `bash` and `jq`. `pp up` starts the service after configuration; use independent credentials for any test instance.

## Synthetic fixtures

[`examples/`](examples/) contains fictional chats, memories, and a disabled task for experimentation. They are not loaded by the service automatically.

## Privacy and development

`data/`, `var/`, `agent/memory/`, `agent/skills/`, agent configuration and `.env` are ignored. The original automatic Git commit and push of private data has been disabled. Review changes before committing, and do not force-add ignored content. The top-level workspace `.gitignore` also excludes the original private snapshot, keys and archives.

The project includes third-party code; see `LICENSE`, `NOTICE` and `src/pool/LICENSE`.

## Testing and deployment

Use the synthetic fixtures and dedicated test credentials in development. Never reuse a production Telegram token for a simultaneous polling instance. Set up production separately using its own `.env` and `agent/` configuration, and keep its persistent `data/`, `var/` and `agent/memory/` outside the public repository with appropriate private backups. No credentials or data are included in the release.

The bootstrap downloads and builds third-party dependencies and requires network access. The bundled CLI and service scripts target Linux; Windows is useful for source editing, but is not a validated deployment platform. Review settings and run offline checks before enabling integrations or scheduling tasks.
