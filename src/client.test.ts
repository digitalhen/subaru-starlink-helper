import { describe, expect, it } from 'vitest';
import { buildCommandForm } from './client.js';
import type { SubaruConfig } from './types.js';

const config: SubaruConfig = {
  username: 'driver@example.com',
  password: 'hunter2',
  pin: '1234',
  vehicleKey: '9999999',
  deviceId: '1700000000000',
  pollTimeoutMs: 1000,
  pollIntervalMs: 10,
};

const NOW = 1_785_197_194_561;

/**
 * Reference payloads extracted from the four shortcuts published at
 * https://reddit.com/r/subaru/comments/1jivfmd — the known-good behaviour this
 * library replaces. `now` and `pin` are substituted for the shortcuts'
 * variable placeholders. If MySubaru changes what it accepts, these should
 * change deliberately rather than by accident.
 */
describe('buildCommandForm matches the published shortcuts', () => {
  it('lock', () => {
    expect(buildCommandForm('lock', config, {}, NOW)).toEqual({
      now: String(NOW),
      pin: '1234',
      delay: '0',
      horn: 'true',
      startConfiguration: 'ALL_DOORS_CMD',
    });
  });

  it('unlock', () => {
    expect(buildCommandForm('unlock', config, {}, NOW)).toEqual({
      now: String(NOW),
      pin: '1234',
      delay: '0',
      horn: 'true',
      startConfiguration: 'ALL_DOORS_CMD',
    });
  });

  it('stop takes the base fields only', () => {
    expect(buildCommandForm('stop', config, {}, NOW)).toEqual({
      now: String(NOW),
      pin: '1234',
      delay: '0',
      horn: 'true',
    });
  });

  it('start carries the full climate payload', () => {
    expect(buildCommandForm('start', config, {}, NOW)).toEqual({
      now: String(NOW),
      pin: '1234',
      delay: '0',
      horn: 'true',
      unlockDoorType: 'ALL_DOORS_CMD',
      name: 'Auto',
      runTimeMinutes: '10',
      climateZoneFrontTemp: '70',
      climateZoneFrontAirMode: 'AUTO',
      climateZoneFrontAirVolume: 'AUTO',
      outerAirCirculation: 'auto',
      heatedRearWindowActive: 'true',
      airConditionOn: 'true',
      heatedSeatFrontLeft: 'off',
      heatedSeatFrontRight: 'off',
      startConfiguration: 'START_ENGINE_ALLOW_KEY_IN_IGNITION',
      disabled: 'false',
      vehicleType: 'gas',
    });
  });
});

describe('command options', () => {
  it('overrides climate settings', () => {
    const form = buildCommandForm(
      'start',
      config,
      { runTimeMinutes: 15, frontTemp: 68, heatedSeatLeft: 'high', airConditioning: false },
      NOW,
    );
    expect(form['runTimeMinutes']).toBe('15');
    expect(form['climateZoneFrontTemp']).toBe('68');
    expect(form['heatedSeatFrontLeft']).toBe('high');
    expect(form['airConditionOn']).toBe('false');
    expect(form['heatedSeatFrontRight']).toBe('off');
  });

  it('suppresses the horn and applies a delay', () => {
    const form = buildCommandForm('lock', config, { horn: false, delay: 600 }, NOW);
    expect(form['horn']).toBe('false');
    expect(form['delay']).toBe('600');
  });

  it('sends the PIN from config, never a literal', () => {
    for (const name of ['lock', 'unlock', 'start', 'stop'] as const) {
      expect(buildCommandForm(name, config, {}, NOW)['pin']).toBe('1234');
    }
  });
});
