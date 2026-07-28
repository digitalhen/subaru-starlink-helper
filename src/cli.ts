#!/usr/bin/env node
import { SubaruClient } from './client.js';
import { loadConfig } from './config.js';
import { discoverVehicles, generateDeviceId } from './discover.js';
import { COMMANDS, SubaruError, type CommandName, type CommandOptions } from './types.js';

const USAGE = `
subaru — remote control for Subaru STARLINK vehicles

Usage:
  subaru <command> [options]

Commands:
  lock            Lock all doors
  unlock          Unlock all doors
  start           Remote start the engine with climate control
  stop            Shut off a running remote start
  status <id>     Check a serviceRequestId returned by --no-wait
  discover        Find the vehicle key and VIN for every car on the account,
                  and print a ready-to-paste .env block

Options:
  --no-wait               Return as soon as the command is accepted, without
                          waiting for the car to confirm it
  --no-horn               Suppress the horn chirp
  --delay <seconds>       Ask the car to wait before acting (default 0)
  --json                  Emit the result as JSON

Remote start options:
  --minutes <n>           Run time, 5/10/15 (default 10)
  --temp <f>              Cabin temperature in Fahrenheit (default 70)
  --no-ac                 Leave air conditioning off
  --no-defrost            Leave the rear defroster off
  --heated-seats          Turn both front seat heaters on

Examples:
  subaru lock
  subaru start --minutes 15 --temp 68 --heated-seats
  subaru unlock --no-horn
  subaru lock --no-wait --json
`.trim();

interface ParsedArgs {
  options: CommandOptions;
  json: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const options: CommandOptions = {};
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      return next;
    };

    switch (arg) {
      case '--no-wait': options.noWait = true; break;
      case '--no-horn': options.horn = false; break;
      case '--no-ac': options.airConditioning = false; break;
      case '--no-defrost': options.rearDefrost = false; break;
      case '--heated-seats':
        options.heatedSeatLeft = 'high';
        options.heatedSeatRight = 'high';
        break;
      case '--json': json = true; break;
      case '--delay': options.delay = Number(value()); break;
      case '--minutes': options.runTimeMinutes = Number(value()); break;
      case '--temp': options.frontTemp = Number(value()); break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { options, json };
}

const VERBS: Record<CommandName, string> = {
  lock: 'Locking',
  unlock: 'Unlocking',
  start: 'Starting',
  stop: 'Stopping',
};

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  // Discovery only needs credentials, not a vehicle — that is what it finds.
  if (command === 'discover') {
    const config = loadConfig({ requireVehicle: false });
    const report = await discoverVehicles(new SubaruClient(config));

    if (rest.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
      return report.vehicles.length ? 0 : 1;
    }

    for (const attempt of report.attempts) {
      console.error(`  ${attempt.source}: ${attempt.note ?? `${attempt.found} found`}`);
    }
    if (report.email) console.error(`  signed in as ${report.email}`);
    console.error('');

    if (report.vehicles.length === 0) {
      console.error(
        'No vehicles found. The login succeeded, so this is likely an endpoint\n' +
          'change on mysubaru.com. Fall back to reading the login request in your\n' +
          "browser's Network tab, and please open an issue with `discover --json`.",
      );
      return 1;
    }

    console.log(`Found ${report.vehicles.length} vehicle(s):\n`);
    for (const [i, v] of report.vehicles.entries()) {
      console.log(`  ${i + 1}. ${v.nickname ?? 'Vehicle'}${v.active ? '  (currently selected)' : ''}`);
      console.log(`     SUBARU_VEHICLE_KEY=${v.vehicleKey ?? '(not found)'}`);
      console.log(`     SUBARU_VIN=${v.vin ?? '(not found)'}`);
    }
    console.log(
      `\n  SUBARU_DEVICE_ID=${config.deviceId ?? generateDeviceId()}` +
        `\n\nKeep an existing SUBARU_DEVICE_ID if you already have one — MySubaru ties` +
        `\nits "remember this device" state to it, and a new value can trigger a` +
        `\ndevice-verification email.`,
    );
    return 0;
  }

  const client = new SubaruClient(loadConfig());

  if (command === 'status') {
    const id = rest[0];
    if (!id) {
      console.error('status requires a serviceRequestId');
      return 1;
    }
    console.log(JSON.stringify(await client.status(id), null, 2));
    return 0;
  }

  if (!(command in COMMANDS)) {
    console.error(`Unknown command: ${command}\n\n${USAGE}`);
    return 1;
  }
  const name = command as CommandName;
  const { options, json } = parseArgs(rest);

  if (!json) {
    process.stderr.write(
      `${VERBS[name]} the car${options.noWait ? '' : ' (waiting for confirmation)'}… `,
    );
  }

  const result = await client.command(name, options);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const seconds = (result.elapsedMs / 1000).toFixed(1);
    if (!result.confirmed) {
      console.error(`accepted in ${seconds}s`);
      console.error(`Check with: subaru status ${result.serviceRequestId}`);
    } else if (result.success) {
      console.error(`done in ${seconds}s`);
    } else {
      console.error(`failed after ${seconds}s (${result.state ?? 'unknown state'})`);
    }
  }

  return result.confirmed && !result.success ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof SubaruError) {
      console.error(`\nError: ${error.message}`);
      if (process.env['DEBUG'] && error.response) {
        console.error(JSON.stringify(error.response, null, 2));
      }
    } else {
      console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(1);
  });
