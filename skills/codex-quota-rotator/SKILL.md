---
name: codex-quota-rotator
description: Monitor OpenClaw Codex OAuth quota and automatically rotate the active openai-codex auth profile when remaining quota drops below a threshold. Use when managing /Users/king/.openclaw/codex_accounts.json and /Users/king/.openclaw/agents/main/agent/auth-profiles.json, or when you want an automatic “switch to a healthy Codex account” watchdog.
---

# Codex quota rotator

This skill maintains the active Codex OAuth profile `openai-codex:default` by:

- Reading: `/Users/king/.openclaw/codex_accounts.json`
- Reading/writing: `/Users/king/.openclaw/agents/main/agent/auth-profiles.json`
- Checking remaining quota (defaults to `quota.hourly_percentage`)
- If remaining < threshold (default 10%), switching the auth profile to another “healthy” account

## Run once (recommended for testing)

```bash
node /Users/king/.agents/skills/codex-quota-rotator/scripts/rotate_once.mjs --threshold 10 --restart-gateway
```

Optional:

- `--profile openai-codex:default`
- `--dry-run`
- `--restart-gateway` (apply changes by restarting `openclaw gateway`)

## Install as a background watchdog (macOS launchd)

1) Generate plist (or edit the template):

```bash
cp /Users/king/.agents/skills/codex-quota-rotator/assets/com.openclaw.codex-quota-rotator.plist \
  ~/Library/LaunchAgents/com.openclaw.codex-quota-rotator.plist
```

2) Load it:

```bash
launchctl unload ~/Library/LaunchAgents/com.openclaw.codex-quota-rotator.plist 2>/dev/null || true
launchctl load  ~/Library/LaunchAgents/com.openclaw.codex-quota-rotator.plist
launchctl start com.openclaw.codex-quota-rotator
```

3) Logs:

- `~/Library/Logs/codex-quota-rotator.log`
- `~/Library/Logs/codex-quota-rotator.err.log`

## Health / selection rules

- Remaining quota is taken from `account.quota.hourly_percentage` when present.
- An account is “healthy” if:
  - remaining >= threshold
  - `quota.raw_data.rate_limit.allowed === true`
- When switching, pick the healthy account with the highest remaining %.

## Safety notes

- This edits `auth-profiles.json`. It writes atomically (temp file + rename).
- Tokens are handled as-is (no network calls). If tokens are expired, the rotation may still switch but the runtime may fail until refreshed.
