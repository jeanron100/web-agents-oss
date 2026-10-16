# Data storage: defaults and optional capabilities

[English](data-storage.md) | [简体中文](../data-storage.md) · [Home](../../../README.en.md)

You do not need every database for first use. Default Compose includes MySQL, and execution nodes retain CLI JSONL records. Add Redis or MongoDB when you need their specific capabilities. They do not connect servers or authenticate coding CLIs for you; start with the [remote setup guide](remote-setup.md).

| Component | Implemented capabilities | When useful | Extra requirements |
|---|---|---|---|
| MySQL, included | Project Token/workload statistics, archives and project-assistant task evidence | Standard installation | Persistent storage, backups and database maintenance |
| Redis, optional | Quota cache, short-lived node heartbeat/state cache, pending-notification deduplication | Multiple nodes, slow quota probes or frequent console restarts | A deployed Redis service, network/authentication and resources |
| MongoDB, optional | Indexes for eligible structured execution events, timelines, session summaries, approval and node-status audits | Central event-level history and audits | A deployed MongoDB service, indexes/storage/backups and resources |

Redis contains lock/lease/idempotency helper functions, but enabling it does not provide multi-Hub high availability or cross-instance idempotency for every write. It does not accelerate vendor model generation. MongoDB complements MySQL task evidence; it does not automatically import every historical record from every engine.

## Redis benefits and limits

The console saves quota values and probe timestamps in Redis and can reload them on restart, reducing expensive CLI/TUI quota probes. Cached values have timestamps and expiry; they are not guaranteed to be current. Notification deduplication reduces repeats within its retention window. Node heartbeats/state use short TTLs.

Without Redis, existing polling, process-local caches and notification deduplication continue. Calls fall back when Redis is unavailable. Its cache can be rebuilt and is not authoritative long-term history.

## MongoDB benefits and limits

Eligible execution events are normalized, redacted and indexed for session timelines and recent project/server event queries, alongside session summaries and audit records. Execution-event projection requires **both `WA_MONGO_ENABLED=1` and `WA_EVENT_SHADOW_WRITE=1`**. A healthy connection alone is not evidence of active ingestion.

Default retention is 180 days for execution/node-status events and 365 days for approval audits; session summaries have no TTL. Failed event writes enter a local console spool, with idempotent replay attempted when MongoDB recovers and projection is enabled. The spool has capacity limits and is not a permanent backup. Execution-node JSONL and MySQL task evidence/archives remain separate.

## Enable an existing service

1. Deploy the optional service you need, with authentication, reachable networking and resource limits. Neither is created automatically by enabling an environment flag.
2. Use the rc.15 or later Compose file, which forwards these variables to the console. Adding them only to an older `.compose.env` without corresponding Compose mappings is insufficient.
3. Add real connection values to the private `.compose.env` in the installation directory. Replace every placeholder and do not publish the file.

```dotenv
WA_REDIS_ENABLED=1
WA_REDIS_URL=redis://your-redis:6379
WA_REDIS_PASS=replace-with-your-redis-password

WA_MONGO_ENABLED=1
WA_EVENT_SHADOW_WRITE=1
WA_MONGO_URI=mongodb://your-user:your-percent-encoded-password@your-mongo:27017/webagents_v2?authSource=admin
WA_MONGO_DB=webagents_v2
```

Use URI encoding for special characters in database credentials, and the appropriate encrypted connection over untrusted networks. Do not shell-source a connection string containing special characters. Container `127.0.0.1` means the console container itself; use endpoints reachable by that container.

4. Recreate only the console with the same Compose file combination used during installation. A plain `restart` does not load new environment variables.

```bash
# Remote-management installation
docker compose --env-file .compose.env -f compose.yaml up -d --no-deps --wait console

# Installation with a local runner: keep the same files, update console only
docker compose --env-file .compose.env -f compose.yaml -f compose.runner.yaml up -d --no-deps --wait console
```

You do not need to recreate a runner, stop remote CLIs or delete volumes. The UI explains configuration and diagnostic status; it does not install database services or edit host services.

## Verify the result

- Settings should report the target service as healthy. An optional service marked not enabled is not a failure.
- Redis: confirm cached quota readings survive a console restart and check notification deduplication within its window. An empty cache still needs a real first probe.
- MongoDB: confirm projection is enabled, run a new eligible task and check indexed-event counts and its timeline. Investigate collection eligibility, switches and connectivity before assuming old history has been imported.
- Authenticated `/api/v2/stats` and `/api/v2/health` report actual health, switches and projection state. Check for faults and continuously growing replay queues.

## Backups and disabling

The existing backup script covers MySQL and the console volume. It **does not back up external MongoDB/Redis services or runner project/account volumes**. Back up MongoDB with its own tools and project files/vendor credentials separately. Redis caches are rebuildable; persistence is your operational choice.

Set the relevant enable flag to `0` and recreate the console to disable a component; disable event projection too when stopping its ingestion. This does not delete external database contents. MySQL faults affect statistics and historical persistence, not just the settings panel.
