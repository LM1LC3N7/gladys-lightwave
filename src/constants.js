// -----------------------------------------------------------------------------
// Manifest keys, Lightwave constants, limits and timings.
//
// The API is the public one of Lightwave (publicapi.lightwaverf.com, the
// "API" page of my.lightwaverf.com gives an API token and a refresh token to
// every account). The token endpoint, the paths and the feature names are
// those of the `LWLink2Public` class of lightwave2 (MIT, AbsenteeAtom /
// Bryan Robert Blunt), the library of the Lightwave Smart custom integration
// of Home Assistant; the scale of the temperatures (tenths of a degree) and
// the meaning of the features come from that integration (MIT, same author).
// The sign-in path of the app (e-mail and password) is never used.
// -----------------------------------------------------------------------------

/** The token endpoint of the public API: a bearer token from the refresh token. */
export const TOKEN_URL = 'https://auth.lightwaverf.com/token';
export const API_ROOT = 'https://publicapi.lightwaverf.com/v1';

/**
 * API paths, relative to API_ROOT. The ids go in as they are (lightwave2
 * does the same; a `+` is part of a feature id): the client accepts only ids
 * of a safe alphabet (`validId`).
 */
export const PATHS = {
  structures: '/structures',
  structure: (structure) => `/structure/${structure}`,
  /** POST `{ features: [{ featureId }] }` -> `{ <featureId>: value }`. */
  read: '/features/read',
  /** POST `{ value }` (a write), GET -> `{ value }` (a read). */
  feature: (feature) => `/feature/${feature}`,
};

/** An honest User-Agent: this integration, its version line and its repository. */
export const USER_AGENT = 'gladys-lightwave/0.1 (+https://github.com/LM1LC3N7/gladys-lightwave)';

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** Refresh interval, in seconds. */
export const POLL_INTERVAL = { min: 30, max: 300, default: 60 };

/**
 * The target temperature of a radiator valve or thermostat, in °C. Lightwave
 * accepts 0 to 40 (the Home Assistant integration); the integration never
 * sends above `max`, the user chooses a lower ceiling (`default`).
 */
export const SETPOINT = { min: 5, max: 40, default: 25 };

/**
 * The features of Lightwave (the `type` of a feature of the hierarchy) the
 * integration reads or writes. Every other one (rgbColor, threeWayRelay,
 * buttonPress, uiButton, protection, identify, upgrade…) is ignored.
 */
export const FEATURES = {
  SWITCH: 'switch',
  DIM_LEVEL: 'dimLevel',
  TEMPERATURE: 'temperature',
  TARGET_TEMPERATURE: 'targetTemperature',
  HEAT_STATE: 'heatState',
  VALVE_LEVEL: 'valveLevel',
  VALVE_SETUP: 'valveSetup',
  CALL_FOR_HEAT: 'callForHeat',
  THREE_WAY_RELAY: 'threeWayRelay',
  POWER: 'power',
  BATTERY_LEVEL: 'batteryLevel',
  WINDOW_POSITION: 'windowPosition',
  MOVEMENT: 'movement',
  HUMIDITY: 'humidity',
  BUTTON_PRESS: 'buttonPress',
};

export const LIMITS = {
  /** Gladys: 300 states per minute; a margin is kept for the commands. */
  statesPerMinute: 250,
  statesPerRequest: 100,
  /** A structure of a large home is a few hundred KB. */
  responseBytes: 2 * 1024 * 1024,
  /** Structures (homes) read per account (one request each per hour). */
  structures: 10,
  /** Feature sets (Gladys devices) published (Gladys accepts 2000 per publication). */
  devices: 500,
  /** Features read per `features/read` request (lightwave2: 150). */
  featuresPerRead: 150,
  /** Longest text kept from an answer (names, product codes). */
  textLength: 100,
  /** Longest identifier accepted from an answer (feature set and feature ids). */
  idLength: 120,
};

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  requestTimeout: 10 * SECOND,
  /** The button (60 s for Gladys): shorter requests. */
  quickTimeout: 8 * SECOND,
  /** The structures of the account are read again every hour (the features every cycle). */
  topologyInterval: HOUR,
  /** A structure not read: the hierarchy is read again this soon. */
  topologyRetry: 5 * MINUTE,
  /**
   * The bearer token lives `expires_in` seconds (one hour assumed without
   * it). It is renewed a tenth of its life before it ends, at least 5
   * minutes, at most 1 hour before.
   */
  tokenDefaultTtl: HOUR,
  tokenMarginMin: 5 * MINUTE,
  tokenMarginMax: HOUR,
  /**
   * Commands (Gladys waits 5 s for the ack): the request must leave within
   * 3 s of the click, or the command is refused unsent; Gladys is answered at
   * 4.3 s at the latest, the request then finishing in the background.
   */
  commandSendBy: 3 * SECOND,
  commandAck: 4300,
  /** The feature set is read again this long after a command, to show its real state. */
  rereadAfterCommand: 2 * SECOND,
  /** A commanded value wins over an older polled one this long, unless a read confirms it. */
  commandHold: 15 * SECOND,
  /** Pauses after a failed read, never shorter than the interval: 1, 2, 5, 10, then 15 min. */
  backoff: [MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE],
  /** 429: Retry-After bounded to 1 minute .. 6 hours, 15 minutes without it. */
  rateLimitMin: MINUTE,
  rateLimitMax: 6 * HOUR,
  rateLimitDefault: 15 * MINUTE,
  /** A 403 of the API that a new token does not cure: one hour, every path. */
  forbiddenPause: HOUR,
  /** Longest a pause read back from /data may still hold. */
  persistedPauseMax: 6 * HOUR,
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  testCooldown: 30 * SECOND,
  /** The time of a read attempt is written to /data at most this often. */
  attemptWriteInterval: MINUTE,
};
