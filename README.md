# subaru-remote

Lock, unlock, remote-start and stop a Subaru over STARLINK — as a TypeScript library, a CLI, and a small authenticated HTTP service.

This is the successor to the iOS Shortcuts I published in [r/subaru: *Universal iOS shortcuts for starting, stopping and unlocking your Subaru over Starlink*](https://www.reddit.com/r/subaru/comments/1jivfmd/universal_ios_shortcuts_for_starting_stopping_and/). Those shortcuts work, but each one embeds a full copy of your MySubaru username, password and PIN. With four or five of them installed, rotating your password means editing every single one — and missing one fails silently until the day you need it.

Here the credentials live in one `.env` file. The Shortcuts become a single HTTP call carrying a revocable token instead of your account password.

> **Requires an active STARLINK subscription with the Security Plus option.** Remote lock/unlock and remote start are not available without it.

## What it does

| | |
|---|---|
| `lock` / `unlock` | All doors, with optional horn confirmation |
| `start` | Remote start with full climate control — run time, temperature, A/C, defrost, heated seats |
| `stop` | Shut off a running remote start |
| `discover` | Find the vehicle key and VIN for every car on your account |

Unlike the original shortcuts, commands are **confirmed rather than fired blind**. MySubaru's `execute.json` only means "accepted for delivery"; the car is reached over cellular and can take 30 seconds or more to actually respond. This library polls `remoteService/status.json` until the car reports back, so a success means the doors really locked.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `SUBARU_USERNAME`, `SUBARU_PASSWORD` and `SUBARU_PIN`, then let the tool find the rest:

```bash
npm run dev:cli -- discover
```

```
Found 1 vehicle(s):

  1. Ascent
     SUBARU_VEHICLE_KEY=1234567
     SUBARU_VIN=4S4WMAWD0X0000000

  SUBARU_DEVICE_ID=1700000000000
```

Paste those into `.env` and you're done.

Discovery reads the vehicle details out of the rendered dashboard, because MySubaru has no vehicle-list API to call — `sessionCheck.json`, `refreshVehicles.json`, `vehicleSelect.json` and `vehicleProfile.json` all return 404, and the dashboard's own scripts request no JSON. That makes it a little more fragile than an API call would be, hence the fallback below.

### If discovery fails

The original Reddit instructions still work as a fallback, and several commenters found `deviceId` hard to locate — so, precisely:

1. Open <https://www.mysubaru.com> with DevTools open on the **Network** tab.
2. Log in.
3. Select the `login` request, then the **Payload** (Chrome) or **Request** (Safari) tab.
4. Copy `lastSelectedVehicleKey` and `deviceId`.

`deviceId` is a millisecond timestamp — a 13-digit number like `1700000000000`. It is chosen by the client, not issued by Subaru, so any stable value is technically valid. **Reuse an existing one where you can**: MySubaru ties its "remember this device" state to it, and a fresh value can trigger a device-verification email.

Your PIN is the four-digit code you use for remote commands on the MySubaru site. It is not your password, and a wrong PIN fails the *command*, not the login — which makes it an easy thing to misdiagnose.

## CLI

```bash
npm run build
node dist/cli.js lock

# or without building
npm run dev:cli -- lock
```

```
subaru lock                                   # lock, wait for confirmation
subaru unlock --no-horn                       # unlock quietly
subaru start --minutes 15 --temp 68           # 15 min, 68°F
subaru start --heated-seats --no-ac           # warm it up
subaru stop
subaru lock --no-wait                         # don't wait for the car
subaru status <serviceRequestId>              # check on a --no-wait command
subaru lock --json                            # machine-readable
```

Exit code is `0` on success and `1` if the car reported failure, so it composes with `&&` and works in cron.

## HTTP service

```bash
API_TOKEN=$(openssl rand -hex 32)   # put this in .env
npm start
```

```
GET|POST /lock      /unlock      /start      /stop
GET      /status/:serviceRequestId
GET      /health                              (unauthenticated)
```

Every command endpoint requires `Authorization: Bearer $API_TOKEN`. The server refuses to start without a token of at least 16 characters — this endpoint can unlock and start your car.

```bash
curl -X POST https://subaru.example.com/start \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"minutes": 15, "temp": 68}'
```

`GET` is accepted as well as `POST` because a plain URL is far easier to wire into an iOS Shortcut or a home-screen widget.

### Rebuilding the Shortcuts against this

Replace all ten actions of the original shortcut with a single **Get Contents of URL**:

- **URL** — `https://subaru.example.com/lock`
- **Method** — `POST`
- **Headers** — `Authorization: Bearer <your token>`

No MySubaru password on the device. If a phone is lost, revoke by changing `API_TOKEN` and restarting; your Subaru account is untouched.

## Library

```ts
import { SubaruClient, loadConfig } from 'subaru-remote';

const car = new SubaruClient(loadConfig());
const result = await car.start({ runTimeMinutes: 15, frontTemp: 68 });

console.log(result.success, result.state, result.elapsedMs);
```

## Docker

```bash
docker compose up -d
```

`docker-compose.yml` reads `.env` from the project root; it is never baked into the image.

## Security

The PSA from the original post applies just as much here, and more so to the HTTP service:

- **Anyone who can reach the service with the token can unlock and start your car.** Put it behind TLS. Do not expose it to the open internet without one.
- **Treat `API_TOKEN` like a car key.** Rotate it if a device carrying it is lost.
- `.env` is gitignored. Keep it that way — check before you commit.
- Anything that unlocks your car from an unlocked phone is a theft risk. Consider requiring Face ID on the Shortcut, or leaving `unlock` off your phone entirely.

## Stability

This drives MySubaru's private `g2` web endpoints. It is not a supported API, there is no contract, and Subaru can change it without notice — the comments on the original thread include a stretch where the login flow changed and every shortcut broke at once.

If commands start failing, check in this order: PIN, then password, then whether `discover` still returns your vehicle. `DEBUG=1` prints the raw API response on error.

What is verified, and what isn't:

- **Command payloads** — extracted from the working shortcuts and asserted against the published Reddit versions in `src/client.test.ts`. All four match exactly.
- **Login and discovery** — exercised against the live site; `discover` returns the correct key, VIN and nickname.
- **Status polling** — the endpoint and body were taken from a real browser session, but the terminal-state handling has not yet been observed against a command in flight.
- **Multi-vehicle pairing** — implemented and unit-tested against a fixture, but not yet run against a real multi-car account. If you have several Subarus on one account, `discover --json` will show what it saw.

## Credits

Thanks to the r/subaru thread that worked out the original endpoints, and to u/notakat for testing the shortcuts.

## License

MIT
