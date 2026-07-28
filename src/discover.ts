import type { SubaruClient } from './client.js';

export interface DiscoveredVehicle {
  vin?: string;
  vehicleKey?: string;
  nickname?: string;
  /** True for the vehicle MySubaru currently has selected on the account. */
  active?: boolean;
}

export interface DiscoveryReport {
  vehicles: DiscoveredVehicle[];
  /** Account email as the dashboard reports it — a useful sanity check. */
  email?: string;
  /** What each extraction step yielded, for diagnosing a layout change. */
  attempts: { source: string; found: number; note?: string }[];
}

/**
 * MySubaru has no vehicle-list API. The dashboard is server-rendered and the
 * vehicle data is embedded directly in the HTML, so discovery fetches
 * /home.html and reads it out. (Probing for a JSON endpoint was tried —
 * sessionCheck.json, refreshVehicles.json, vehicleSelect.json and
 * vehicleProfile.json all return 404, and the page's own scripts request no
 * JSON at all.)
 */
export async function discoverVehicles(client: SubaruClient): Promise<DiscoveryReport> {
  const attempts: DiscoveryReport['attempts'] = [];

  let html: string;
  try {
    const res = await client.call('/home.html');
    if (res.status !== 200) {
      return {
        vehicles: [],
        attempts: [{ source: '/home.html', found: 0, note: `HTTP ${res.status}` }],
      };
    }
    html = res.text;
  } catch (error) {
    return {
      vehicles: [],
      attempts: [
        { source: '/home.html', found: 0, note: error instanceof Error ? error.message : String(error) },
      ],
    };
  }

  // A login form in the response means the session did not take.
  if (/name=["']password["']/i.test(html)) {
    return {
      vehicles: [],
      attempts: [{ source: '/home.html', found: 0, note: 'served the login page — not authenticated' }],
    };
  }

  const parsed = parseDashboard(html);
  attempts.push(...parsed.attempts);
  return { ...parsed, attempts };
}

/**
 * Pull the account and vehicle details out of dashboard HTML. Split from the
 * fetch so it can be tested against a fixture without a live session.
 */
export function parseDashboard(html: string): DiscoveryReport {
  const email = html.match(/id\s*=\s*["']email["']\s+value\s*=\s*["']([^"']+)["']/i)?.[1];

  const keys = extractKeys(html);
  const vins = extractVins(html);
  const vehicles = pair(keys, vins, extractNames(html));

  return {
    vehicles,
    email,
    attempts: [
      { source: 'vehicle key markers', found: keys.length },
      { source: 'VIN markers', found: vins.length },
      { source: 'paired', found: vehicles.length },
    ],
  };
}

interface Positioned {
  value: string;
  index: number;
  active?: boolean;
}

/**
 * Vehicle keys appear in three places on the dashboard. Note the misspelled
 * `currenVehicleKey` — that is Subaru's typo, not ours, and it identifies the
 * currently selected vehicle.
 */
function extractKeys(html: string): Positioned[] {
  const found: Positioned[] = [];

  const current = html.match(/id\s*=\s*["']curren[t]?VehicleKey["']\s+value\s*=\s*["'](\d{4,12})["']/i);
  if (current?.[1]) found.push({ value: current[1], index: current.index ?? 0, active: true });

  const setter = html.match(/setlastSelectedVehicleKey\(\s*['"][^'"]*['"]\s*,\s*['"](\d{4,12})['"]/i);
  if (setter?.[1]) found.push({ value: setter[1], index: setter.index ?? 0, active: true });

  // The vehicle switcher renders one toggle per car on the account, keyed by
  // vehicle key. This is what surfaces the second and subsequent vehicles.
  for (const m of html.matchAll(
    /class=["'][^"']*vehicle-attention-bar__vehicle-info-toggle[^"']*["']\s+id=["'](\d{4,12})["']/gi,
  )) {
    if (m[1]) found.push({ value: m[1], index: m.index ?? 0 });
  }

  return dedupe(found);
}

/** Subaru VINs are 17 characters and begin JF (Japan) or 4S (Indiana). */
function extractVins(html: string): Positioned[] {
  const found: Positioned[] = [];
  for (const m of html.matchAll(/\b((?:JF|4S)[A-HJ-NPR-Z0-9]{15})\b/g)) {
    if (m[1]) found.push({ value: m[1], index: m.index ?? 0 });
  }
  return dedupe(found);
}

function extractNames(html: string): Positioned[] {
  const found: Positioned[] = [];
  for (const m of html.matchAll(
    /class=["'][^"']*vehicle-attention-bar__heading[^"']*["'][^>]*>\s*([^<]{1,40}?)\s*</gi,
  )) {
    if (m[1]) found.push({ value: m[1], index: m.index ?? 0 });
  }
  return dedupe(found);
}

function dedupe(items: Positioned[]): Positioned[] {
  const byValue = new Map<string, Positioned>();
  for (const item of items) {
    const existing = byValue.get(item.value);
    // Keep the earliest occurrence, but let an `active` marker win.
    if (!existing) byValue.set(item.value, item);
    else if (item.active && !existing.active) byValue.set(item.value, { ...existing, active: true });
  }
  return [...byValue.values()].sort((a, b) => a.index - b.index);
}

/**
 * Associate each key with its VIN and name by document proximity — a
 * vehicle's markup is contiguous, so the nearest VIN to a key belongs to it.
 *
 * Verified against a single-vehicle account. Multi-vehicle pairing follows the
 * same structure but has not been tested against a real multi-car account; if
 * it mismatches, `discover --json` shows the raw positions.
 */
function pair(keys: Positioned[], vins: Positioned[], names: Positioned[]): DiscoveredVehicle[] {
  if (keys.length === 0 && vins.length === 0) return [];

  // No key found at all — still report the VINs so the user has something.
  if (keys.length === 0) return vins.map((v) => ({ vin: v.value }));

  const nearest = (pool: Positioned[], index: number): string | undefined => {
    let best: Positioned | undefined;
    let bestDistance = Infinity;
    for (const candidate of pool) {
      const distance = Math.abs(candidate.index - index);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    return best?.value;
  };

  // With one vehicle every marker belongs to it, so skip proximity entirely.
  if (keys.length === 1) {
    return [
      {
        vehicleKey: keys[0]!.value,
        vin: vins[0]?.value,
        nickname: names[0]?.value,
        active: true,
      },
    ];
  }

  return keys.map((key) => ({
    vehicleKey: key.value,
    vin: nearest(vins, key.index),
    nickname: nearest(names, key.index),
    active: key.active ?? false,
  }));
}

/**
 * A deviceId is a client-chosen identifier, not something the account issues,
 * so a fresh one is valid. Reuse an existing value where possible: MySubaru
 * ties its "remember this device" state to it, and a new id can trigger the
 * account's device-verification email.
 */
export function generateDeviceId(now = Date.now()): string {
  return String(now);
}
