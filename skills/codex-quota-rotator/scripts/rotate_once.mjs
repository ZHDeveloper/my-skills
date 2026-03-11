#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CODEX_ACCOUNTS_PATH = '/Users/king/.openclaw/codex_accounts.json';
const AUTH_PROFILES_PATH = '/Users/king/.openclaw/agents/main/agent/auth-profiles.json';

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function parseArgs(argv) {
  const args = {
    threshold: 10,
    profile: 'openai-codex:default',
    dryRun: false,
    restartGateway: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--threshold') args.threshold = Number(argv[++i]);
    else if (a === '--profile') args.profile = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--restart-gateway') args.restartGateway = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: rotate_once.mjs [--threshold 10] [--profile openai-codex:default] [--dry-run] [--restart-gateway]`);
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.threshold)) throw new Error('Invalid --threshold');
  return args;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function jwtPayload(token) {
  // token: header.payload.signature (base64url)
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const json = Buffer.from(b64 + pad, 'base64').toString('utf8');
  return JSON.parse(json);
}

function extractChatGPTAccountIdFromAccessToken(accessToken) {
  const payload = jwtPayload(accessToken);
  const auth = payload?.['https://api.openai.com/auth'];
  const id = auth?.chatgpt_account_id || auth?.chatgptAccountId || auth?.account_id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

function calcRemainingFromUsedPercent(usedPercent) {
  if (typeof usedPercent !== 'number') return null;
  const used = Math.max(0, Math.min(100, usedPercent));
  return 100 - used;
}

function deriveQuotaFromUsageResponse(raw) {
  // mirror cockpit-tools logic (primary_window => hourly/session, secondary_window => weekly)
  const rateLimit = raw?.rate_limit;
  const primary = rateLimit?.primary_window;
  const secondary = rateLimit?.secondary_window;

  const hourlyUsed = primary?.used_percent;
  const weeklyUsed = secondary?.used_percent;

  const hourly_percentage = calcRemainingFromUsedPercent(hourlyUsed) ?? 100;
  const weekly_percentage = calcRemainingFromUsedPercent(weeklyUsed) ?? 100;

  const hourly_reset_time = primary?.reset_at ?? null;
  const weekly_reset_time = secondary?.reset_at ?? null;

  const hourly_window_minutes =
    typeof primary?.limit_window_seconds === 'number' && primary.limit_window_seconds > 0
      ? Math.ceil(primary.limit_window_seconds / 60)
      : null;
  const weekly_window_minutes =
    typeof secondary?.limit_window_seconds === 'number' && secondary.limit_window_seconds > 0
      ? Math.ceil(secondary.limit_window_seconds / 60)
      : null;

  return {
    hourly_percentage,
    hourly_reset_time,
    hourly_window_minutes,
    hourly_window_present: primary ? true : false,

    weekly_percentage,
    weekly_reset_time,
    weekly_window_minutes,
    weekly_window_present: secondary ? true : false,

    raw_data: raw,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchUsageQuotaForAccount(account) {
  const accessToken = account?.tokens?.access_token;
  if (!accessToken) throw new Error('missing access_token');

  const accountIdHeader = account?.account_id || extractChatGPTAccountIdFromAccessToken(accessToken);

  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${accessToken}`,
  };
  if (accountIdHeader) headers['ChatGPT-Account-Id'] = accountIdHeader;

  // Retry once on transient network failures
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(CODEX_USAGE_URL, { method: 'GET', headers });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }

      if (!res.ok) {
        const code = json?.detail?.code || json?.code;
        const preview = text?.slice(0, 200);
        throw new Error(
          `usage api ${res.status} ${res.statusText}${code ? ` [error_code:${code}]` : ''} - ${preview}`
        );
      }

      return { raw: json ?? {}, quota: deriveQuotaFromUsageResponse(json ?? {}) };
    } catch (e) {
      if (attempt >= 2) throw e;
      await sleep(500);
    }
  }

  // unreachable
  throw new Error('failed to fetch usage quota');
}

function remainingPct(account) {
  if (typeof account?.quota?.hourly_percentage === 'number') return account.quota.hourly_percentage;
  const used = account?.quota?.raw_data?.rate_limit?.primary_window?.used_percent;
  const rem = calcRemainingFromUsedPercent(used);
  return typeof rem === 'number' ? rem : null;
}

function isHealthy(account, threshold) {
  const rem = remainingPct(account);
  const allowed = account?.quota?.raw_data?.rate_limit?.allowed;
  return typeof rem === 'number' && rem >= threshold && allowed === true;
}

function atomicWriteJson(targetPath, obj) {
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, `.tmp.${path.basename(targetPath)}.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, targetPath);
}

async function main() {
  const { threshold, profile, dryRun, restartGateway } = parseArgs(process.argv);

  const accounts = readJson(CODEX_ACCOUNTS_PATH);
  const authProfiles = readJson(AUTH_PROFILES_PATH);

  const p = authProfiles?.profiles?.[profile];
  if (!p) throw new Error(`Profile not found: ${profile}`);

  let currentAccountId = p.accountId;
  if (!currentAccountId && p.access) {
    currentAccountId = extractChatGPTAccountIdFromAccessToken(p.access);
  }
  let current = accounts.find(a => a.account_id === currentAccountId);

  const now = new Date().toISOString();

  // Always refresh current account quota (cockpit-tools approach)
  if (current) {
    try {
      const { quota } = await fetchUsageQuotaForAccount(current);
      current.quota = quota;
      current.quota_error = null;

      // persist back to codex_accounts.json
      if (!dryRun) {
        atomicWriteJson(CODEX_ACCOUNTS_PATH, accounts);
      }
    } catch (e) {
      current.quota_error = { message: String(e?.message || e), timestamp: Date.now() };
      console.error(`[${now}] WARN: failed to refresh current quota: ${current.quota_error.message}`);
      if (!dryRun) atomicWriteJson(CODEX_ACCOUNTS_PATH, accounts);
    }
  }

  const currentRemaining = current ? remainingPct(current) : null;
  console.log(`[${now}] current accountId=${currentAccountId ?? 'null'} remaining=${currentRemaining ?? 'unknown'}% threshold=${threshold}%`);

  const needSwitch = currentRemaining === null || currentRemaining < threshold;
  if (!needSwitch) {
    console.log(`[${now}] OK: no switch needed.`);
    return;
  }

  // If switching is needed, refresh all candidates so "healthy" is based on real-time quota
  for (const acc of accounts) {
    if (acc.account_id === currentAccountId) continue;
    try {
      const { quota } = await fetchUsageQuotaForAccount(acc);
      acc.quota = quota;
      acc.quota_error = null;
    } catch (e) {
      acc.quota_error = { message: String(e?.message || e), timestamp: Date.now() };
    }
  }

  if (!dryRun) {
    atomicWriteJson(CODEX_ACCOUNTS_PATH, accounts);
  }

  const healthy = accounts
    .filter(a => a.account_id !== currentAccountId)
    .filter(a => isHealthy(a, threshold))
    .map(a => ({
      account: a,
      remaining: remainingPct(a),
    }))
    .sort((x, y) => (y.remaining ?? -1) - (x.remaining ?? -1));

  const best = healthy[0]?.account;
  if (!best) {
    console.log(`[${now}] WARN: current remaining < threshold but no healthy alternative found.`);
    return;
  }

  const nextAccess = best?.tokens?.access_token;
  const nextRefresh = best?.tokens?.refresh_token;
  const payload = jwtPayload(nextAccess);
  const nextExpiresMs = payload?.exp ? payload.exp * 1000 : (Date.now() + 55 * 60 * 1000);

  console.log(`[${now}] SWITCH: ${currentAccountId} -> ${best.account_id} (${best.email}) remaining=${remainingPct(best)}%`);

  if (dryRun) {
    console.log(`[${now}] dry-run: not writing auth-profiles.json`);
    return;
  }

  authProfiles.profiles[profile] = {
    ...p,
    access: nextAccess,
    refresh: nextRefresh,
    expires: nextExpiresMs,
    accountId: best.account_id,
  };

  atomicWriteJson(AUTH_PROFILES_PATH, authProfiles);
  console.log(`[${now}] WROTE: ${AUTH_PROFILES_PATH}`);

  if (restartGateway) {
    try {
      console.log(`[${now}] restarting gateway: openclaw gateway restart`);
      execFileSync('openclaw', ['gateway', 'restart'], { stdio: 'inherit' });
      console.log(`[${now}] gateway restarted`);
    } catch (e) {
      console.error(`[${now}] ERROR: failed to restart gateway: ${String(e?.message || e)}`);
      process.exitCode = 2;
    }
  }
}

main().catch((err) => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
