import {
  COMMANDS,
  SubaruError,
  type CommandName,
  type CommandOptions,
  type CommandResult,
  type SubaruConfig,
  type SubaruResponse,
} from './types.js';

const BASE_URL = 'https://www.mysubaru.com';

/**
 * MySubaru's g2 endpoints are guarded against non-browser callers — the
 * `x-requested-with` header in particular is checked. These mirror what the
 * web app sends.
 */
const BROWSER_HEADERS: Record<string, string> = {
  accept: 'application/json, text/javascript, */*; q=0.01',
  'accept-language': 'en-US,en;q=0.9',
  'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
  origin: BASE_URL,
  referer: `${BASE_URL}/home.html`,
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  'x-requested-with': 'XMLHttpRequest',
};

/** States the API reports once a command has stopped moving. */
const TERMINAL_STATES = new Set(['finished', 'cancelled', 'canceled', 'error', 'failed']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SubaruClient {
  /** name -> value. Enough of a cookie jar for a single-origin session. */
  private cookies = new Map<string, string>();
  private authenticated = false;

  constructor(private readonly config: SubaruConfig) {}

  // -- session ------------------------------------------------------------

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private storeCookies(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';', 1)[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  private async post(path: string, form: Record<string, string>, manualRedirect = false) {
    const cookie = this.cookieHeader();
    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { ...BROWSER_HEADERS, ...(cookie ? { cookie } : {}) },
      body: new URLSearchParams(form).toString(),
      redirect: manualRedirect ? 'manual' : 'follow',
    });
    this.storeCookies(response);
    return response;
  }

  private async postJson(path: string, form: Record<string, string>): Promise<SubaruResponse> {
    const response = await this.post(path, form);
    const text = await response.text();

    let parsed: SubaruResponse;
    try {
      parsed = JSON.parse(text) as SubaruResponse;
    } catch {
      // An HTML body here almost always means the session lapsed and we were
      // bounced to the login page.
      throw new SubaruError(
        `Expected JSON from ${path} but got ${response.status} ` +
          `${response.headers.get('content-type') ?? 'unknown content-type'}. ` +
          `The session may have expired.`,
      );
    }
    return parsed;
  }

  /**
   * Authenticate and capture the session cookie.
   *
   * MySubaru's /login returns a redirect rather than JSON, so success is
   * inferred: a failed login bounces back to a URL still containing "login".
   */
  async login(): Promise<void> {
    const response = await this.post(
      '/login',
      {
        username: this.config.username,
        password: this.config.password,
        lastSelectedVehicleKey: this.config.vehicleKey,
        deviceId: this.config.deviceId,
      },
      true,
    );

    const location = response.headers.get('location') ?? '';
    if (location.includes('/login') || location.includes('error')) {
      throw new SubaruError(
        'Login rejected by MySubaru. Check SUBARU_USERNAME and SUBARU_PASSWORD.',
      );
    }
    if (!this.cookies.has('JSESSIONID')) {
      throw new SubaruError(
        `Login did not return a session cookie (HTTP ${response.status}). ` +
          `The login flow may have changed.`,
      );
    }
    this.authenticated = true;
  }

  private async ensureLogin(): Promise<void> {
    if (!this.authenticated) await this.login();
  }

  // -- commands -----------------------------------------------------------

  /**
   * Send a command and, unless `noWait`, poll until the car confirms it.
   *
   * The execute call only means "accepted for delivery" — the car is reached
   * over cellular and can take 30s+ to actually respond, which is why the
   * polling step exists.
   */
  async command(name: CommandName, options: CommandOptions = {}): Promise<CommandResult> {
    await this.ensureLogin();
    const startedAt = Date.now();

    const accepted = await this.postJson(
      `/service/g2/${COMMANDS[name]}/execute.json`,
      buildCommandForm(name, this.config, options),
    );

    const serviceRequestId = extractServiceRequestId(accepted);
    if (accepted.success === false || !serviceRequestId) {
      throw new SubaruError(
        `${name} was rejected by MySubaru` +
          (accepted.errorCode ? ` (${accepted.errorCode})` : '') +
          (serviceRequestId ? '' : ' — no serviceRequestId was returned'),
        accepted.errorCode,
        accepted,
      );
    }

    if (options.noWait) {
      return {
        command: name,
        success: true,
        serviceRequestId,
        confirmed: false,
        elapsedMs: Date.now() - startedAt,
        raw: accepted,
      };
    }

    const final = await this.pollUntilDone(serviceRequestId);
    const data = (final.data ?? {}) as Record<string, unknown>;
    const state = typeof data['remoteServiceState'] === 'string' ? data['remoteServiceState'] : undefined;

    // The envelope's `success` reports whether the *poll* worked; the nested
    // one reports whether the car did the thing.
    const carSucceeded = data['success'] === true || (data['success'] === undefined && final.success === true);

    return {
      command: name,
      success: carSucceeded,
      serviceRequestId,
      state,
      errorCode: final.errorCode ?? (data['errorCode'] as string | undefined) ?? null,
      confirmed: true,
      elapsedMs: Date.now() - startedAt,
      raw: final,
    };
  }

  /** Poll the status endpoint until the command reaches a terminal state. */
  async pollUntilDone(serviceRequestId: string): Promise<SubaruResponse> {
    const deadline = Date.now() + this.config.pollTimeoutMs;
    let last: SubaruResponse = {};

    while (Date.now() < deadline) {
      last = await this.status(serviceRequestId);
      const state = (last.data as Record<string, unknown> | undefined)?.['remoteServiceState'];
      if (typeof state === 'string' && TERMINAL_STATES.has(state.toLowerCase())) return last;
      await sleep(this.config.pollIntervalMs);
    }

    throw new SubaruError(
      `Timed out after ${this.config.pollTimeoutMs}ms waiting for ${serviceRequestId}. ` +
        `The command may still complete — the car was simply slow to report back.`,
      null,
      last,
    );
  }

  /** Single status check for an in-flight command. */
  async status(serviceRequestId: string): Promise<SubaruResponse> {
    await this.ensureLogin();
    return this.postJson('/service/g2/remoteService/status.json', { serviceRequestId });
  }

  /**
   * Issue an arbitrary authenticated request against the site. Used by the
   * discovery flow, which has to probe endpoints whose shapes we don't know
   * ahead of time — hence the raw text rather than a parsed envelope.
   */
  async call(
    path: string,
    form?: Record<string, string>,
  ): Promise<{ status: number; contentType: string; text: string }> {
    await this.ensureLogin();
    const cookie = this.cookieHeader();
    const response = form
      ? await this.post(path, form)
      : await fetch(`${BASE_URL}${path}`, {
          headers: {
            ...BROWSER_HEADERS,
            accept: 'text/html,application/xhtml+xml,application/json,*/*',
            ...(cookie ? { cookie } : {}),
          },
        });
    if (!form) this.storeCookies(response);
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      text: await response.text(),
    };
  }

  lock(options?: CommandOptions) {
    return this.command('lock', options);
  }
  unlock(options?: CommandOptions) {
    return this.command('unlock', options);
  }
  start(options?: CommandOptions) {
    return this.command('start', options);
  }
  stop(options?: CommandOptions) {
    return this.command('stop', options);
  }
}

// -- form construction ----------------------------------------------------

function extractServiceRequestId(response: SubaruResponse): string | undefined {
  const data = response.data as Record<string, unknown> | undefined;
  const candidate = data?.['serviceRequestId'] ?? response['serviceRequestId'];
  return typeof candidate === 'string' ? candidate : undefined;
}

/**
 * Build the form body for a command.
 *
 * Every command carries `now` (a millisecond epoch the API uses for replay
 * protection), the PIN, a delay and the horn flag. Lock/unlock add a door
 * scope; start adds the full climate payload.
 */
export function buildCommandForm(
  name: CommandName,
  config: SubaruConfig,
  options: CommandOptions = {},
  now = Date.now(),
): Record<string, string> {
  const form: Record<string, string> = {
    now: String(now),
    pin: config.pin,
    delay: String(options.delay ?? 0),
    horn: String(options.horn ?? true),
  };

  if (name === 'lock' || name === 'unlock') {
    form['startConfiguration'] = 'ALL_DOORS_CMD';
    return form;
  }

  if (name === 'start') {
    const o = options;
    return {
      ...form,
      unlockDoorType: 'ALL_DOORS_CMD',
      name: 'Auto',
      runTimeMinutes: String(o.runTimeMinutes ?? 10),
      climateZoneFrontTemp: String(o.frontTemp ?? 70),
      climateZoneFrontAirMode: o.airMode ?? 'AUTO',
      climateZoneFrontAirVolume: o.airVolume ?? 'AUTO',
      outerAirCirculation: o.outerAirCirculation ?? 'auto',
      heatedRearWindowActive: String(o.rearDefrost ?? true),
      airConditionOn: String(o.airConditioning ?? true),
      heatedSeatFrontLeft: o.heatedSeatLeft ?? 'off',
      heatedSeatFrontRight: o.heatedSeatRight ?? 'off',
      startConfiguration: 'START_ENGINE_ALLOW_KEY_IN_IGNITION',
      disabled: 'false',
      vehicleType: o.vehicleType ?? 'gas',
    };
  }

  return form; // engineStop takes the base fields only.
}
