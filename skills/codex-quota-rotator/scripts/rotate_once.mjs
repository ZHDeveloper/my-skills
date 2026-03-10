#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CODEX_ACCOUNTS_PATH = '/Users/king/.openclaw/codex_accounts.json';
const AUTH_PROFILES_PATH = '/Users/king/.openclaw/agents/main/agent/auth-profiles.json';

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

function remainingPct(account) {
  if (typeof account?.quota?.hourly_percentage === 'number') return account.quota.hourly_percentage;
  const used = account?.quota?.raw_data?.rate_limit?.primary_window?.used_percent;
  if (typeof used === 'number') return Math.max(0, Math.min(100, 100 - used));
  return null;
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

function main() {
  const { threshold, profile, dryRun, restartGateway } = parseArgs(process.argv);

  const accounts = readJson(CODEX_ACCOUNTS_PATH);
  const authProfiles = readJson(AUTH_PROFILES_PATH);

  const p = authProfiles?.profiles?.[profile];
  if (!p) throw new Error(`Profile not found: ${profile}`);

  const currentAccountId = p.accountId;
  const current = accounts.find(a => a.account_id === currentAccountId);
  const currentRemaining = current ? remainingPct(current) : null;

  const healthy = accounts
    .filter(a => a.account_id !== currentAccountId)
    .filter(a => isHealthy(a, threshold))
    .map(a => ({
      account: a,
      remaining: remainingPct(a),
    }))
    .sort((x, y) => (y.remaining ?? -1) - (x.remaining ?? -1));

  const needSwitch = typeof currentRemaining === 'number' && currentRemaining < threshold;

  const now = new Date().toISOString();
  console.log(`[${now}] current accountId=${currentAccountId ?? 'null'} remaining=${currentRemaining ?? 'unknown'}% threshold=${threshold}%`);

  if (!needSwitch) {
    console.log(`[${now}] OK: no switch needed.`);
    return;
  }

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

try {
  main();
} catch (err) {
  console.error(String(err?.stack || err));
  process.exit(1);
}
