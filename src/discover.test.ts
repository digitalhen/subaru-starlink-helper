import { describe, expect, it } from 'vitest';
import { parseDashboard } from './discover.js';

/**
 * Trimmed from a real logged-in /home.html, with identifiers replaced. The
 * markers are reproduced exactly — including Subaru's `currenVehicleKey`
 * misspelling, which is load-bearing.
 */
const SINGLE_VEHICLE = `
<input type="hidden" id="email" value="driver@example.com" />
<input type = "hidden" id = "currenVehicleKey" value="1234567" />
<div class="vehicle-attention-bar__vehicle-info-toggle active_vehicle" id="1234567" name="1"> Ascent </div>
<span class="vehicle-attention-bar__heading">Ascent</span>
<span class="vehicle-attention-bar__small-text">VIN: 4S4WMAWD0X0000001</span>
<input type="text" class="form-control" id="vinDetail" value="4S4WMAWD0X0000001" disabled>
<script>setlastSelectedVehicleKey('driver@example.com', '1234567');</script>
`;

const TWO_VEHICLES = `
<input type="hidden" id="email" value="driver@example.com" />
<input type = "hidden" id = "currenVehicleKey" value="1111111" />
<div class="vehicle-attention-bar__vehicle-info-toggle active_vehicle" id="1111111" name="1"></div>
<span class="vehicle-attention-bar__heading">Ascent</span>
<span class="vehicle-attention-bar__small-text">VIN: 4S4WMAWD0X0000001</span>
${'<span>filler</span>'.repeat(200)}
<div class="vehicle-attention-bar__vehicle-info-toggle" id="2222222" name="2"></div>
<span class="vehicle-attention-bar__heading">Outback</span>
<span class="vehicle-attention-bar__small-text">VIN: JF2SJAEC0X0000002</span>
`;

describe('parseDashboard', () => {
  it('extracts the vehicle from a single-car account', () => {
    const report = parseDashboard(SINGLE_VEHICLE);
    expect(report.email).toBe('driver@example.com');
    expect(report.vehicles).toEqual([
      { vehicleKey: '1234567', vin: '4S4WMAWD0X0000001', nickname: 'Ascent', active: true },
    ]);
  });

  it('pairs each key with its own VIN across multiple vehicles', () => {
    const { vehicles } = parseDashboard(TWO_VEHICLES);
    expect(vehicles).toHaveLength(2);

    const ascent = vehicles.find((v) => v.vehicleKey === '1111111');
    expect(ascent?.vin).toBe('4S4WMAWD0X0000001');
    expect(ascent?.active).toBe(true);

    const outback = vehicles.find((v) => v.vehicleKey === '2222222');
    expect(outback?.vin).toBe('JF2SJAEC0X0000002');
    expect(outback?.active).toBe(false);
  });

  it('reads the misspelled currenVehicleKey field', () => {
    const html = '<input id="currenVehicleKey" value="7654321" />';
    expect(parseDashboard(html).vehicles[0]?.vehicleKey).toBe('7654321');
  });

  it('ignores strings that only look like VINs', () => {
    // Right length and prefix, but contains I/O/Q which VINs never do.
    const html = '<p>4S4WMAWDIOQ000000</p><input id="currenVehicleKey" value="1234" />';
    expect(parseDashboard(html).vehicles[0]?.vin).toBeUndefined();
  });

  it('returns nothing for a page with no vehicle markers', () => {
    expect(parseDashboard('<html><body>Nothing here</body></html>').vehicles).toEqual([]);
  });
});
