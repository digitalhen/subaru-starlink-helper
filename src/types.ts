/** The four remote commands, mapped to their g2 endpoint segment. */
export const COMMANDS = {
  lock: 'lock',
  unlock: 'unlock',
  start: 'engineStart',
  stop: 'engineStop',
} as const;

export type CommandName = keyof typeof COMMANDS;

export interface SubaruConfig {
  username: string;
  password: string;
  pin: string;
  vehicleKey: string;
  /** Informational only — the API returns the serviceRequestId that embeds it. */
  vin?: string;
  deviceId: string;
  pollTimeoutMs: number;
  pollIntervalMs: number;
}

/** Climate and engine settings for a remote start. */
export interface StartOptions {
  /** Minutes to run before shutting off. MySubaru accepts 5, 10 or 15. */
  runTimeMinutes?: number;
  /** Cabin target temperature in Fahrenheit. */
  frontTemp?: number;
  airMode?: string;
  airVolume?: string;
  outerAirCirculation?: string;
  rearDefrost?: boolean;
  airConditioning?: boolean;
  heatedSeatLeft?: string;
  heatedSeatRight?: string;
  /** `gas` or `phev`. Determines which start configuration the API accepts. */
  vehicleType?: string;
}

export interface CommandOptions extends StartOptions {
  /** Seconds the car waits before acting. The API takes this, not the client. */
  delay?: number;
  /** Sound the horn as confirmation. */
  horn?: boolean;
  /** Skip polling and return as soon as the command is accepted. */
  noWait?: boolean;
}

/**
 * MySubaru wraps every response in this envelope. `data` is loosely typed
 * because its shape varies per endpoint and we pass it through to callers.
 */
export interface SubaruResponse {
  success?: boolean;
  errorCode?: string | null;
  dataName?: string;
  data?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface CommandResult {
  command: CommandName;
  /** True only when the car confirmed the command, not merely accepted it. */
  success: boolean;
  /** Populated once the command is accepted; used for status polling. */
  serviceRequestId?: string;
  /** Terminal remoteServiceState, e.g. `finished`. */
  state?: string;
  errorCode?: string | null;
  /** Whether we polled to completion or returned early. */
  confirmed: boolean;
  /** Wall-clock time from request to terminal state. */
  elapsedMs: number;
  /** Raw final response, for debugging anything this shape misses. */
  raw?: SubaruResponse;
}

export class SubaruError extends Error {
  constructor(
    message: string,
    readonly code?: string | null,
    readonly response?: SubaruResponse,
  ) {
    super(message);
    this.name = 'SubaruError';
  }
}
