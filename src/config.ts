import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SubaruConfig } from './types.js';

/**
 * Minimal .env loader. Node 20.6+ can do this with --env-file, but reading it
 * ourselves keeps `npx tsx src/cli.ts` working without extra flags. Values
 * already present in the real environment always win.
 */
export function loadDotenv(path = resolve(process.cwd(), '.env')): void {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return; // No .env is fine — the environment may supply everything.
  }

  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    // Strip matching surrounding quotes, so passwords with # or spaces survive.
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = value;
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function numeric(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export interface LoadOptions {
  /**
   * Discovery runs before the vehicle key and PIN are known, so it logs in
   * with credentials alone.
   */
  requireVehicle?: boolean;
}

export function loadConfig({ requireVehicle = true }: LoadOptions = {}): SubaruConfig {
  loadDotenv();

  const optional = (name: string) => process.env[name]?.trim() || undefined;

  return {
    username: required('SUBARU_USERNAME'),
    password: required('SUBARU_PASSWORD'),
    pin: requireVehicle ? required('SUBARU_PIN') : (optional('SUBARU_PIN') ?? ''),
    vehicleKey: requireVehicle ? required('SUBARU_VEHICLE_KEY') : (optional('SUBARU_VEHICLE_KEY') ?? ''),
    vin: optional('SUBARU_VIN'),
    // Must be a deviceId MySubaru already trusts — a generated one hits 2FA.
    deviceId: optional('SUBARU_DEVICE_ID') ?? String(Date.now()),
    pollTimeoutMs: numeric('POLL_TIMEOUT_MS', 120_000),
    pollIntervalMs: numeric('POLL_INTERVAL_MS', 2_000),
  };
}
