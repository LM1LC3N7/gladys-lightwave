// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized, plus the one
// key the integration keeps in the Gladys configuration outside the schema
// (`setConfig`, never shown): `refresh_token_state`, a JSON string holding the
// refresh token Lightwave gave last (`current`) and a hash of the token the
// user had pasted when it was obtained (`seed`, never the token itself). One
// key, so the two are always written together. Lightwave gives (per
// lightwave2) a new refresh token at every renewal of the bearer token: it is
// kept in the Gladys database, as the secret fields are, never in /data.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { POLL_INTERVAL, SETPOINT } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  poll_interval: POLL_INTERVAL.default,
  allow_heating: false,
  max_setpoint: SETPOINT.default,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

/** The key kept outside the schema. */
export const INTERNAL_KEYS = {
  state: 'refresh_token_state',
};

/** The hash of a pasted refresh token (16 hex digits): what the rotated one derives from. */
export const seedHash = (token) =>
  createHash('sha256')
    .update(String(token ?? '').trim())
    .digest('hex')
    .slice(0, 16);

/** The value of `refresh_token_state`. */
export const tokenState = (seed, current) => JSON.stringify({ seed, current });

/** `refresh_token_state` read back: `{ seed, current }` or undefined. */
export function readTokenState(raw) {
  let state = raw;
  if (typeof raw === 'string') {
    try {
      state = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (
    !state ||
    typeof state !== 'object' ||
    !/^[0-9a-f]{16}$/.test(state.seed ?? '') ||
    typeof state.current !== 'string' ||
    state.current.trim() === '' ||
    state.current.length > 4096
  ) {
    return undefined;
  }
  return { seed: state.seed, current: state.current.trim() };
}

/** A short hash of the API token: the account a pause or a stop belongs to, without the token. */
export const accountKey = (apiToken) =>
  createHash('sha256').update(apiToken.trim()).digest('hex').slice(0, 16);

const bounded = (raw, { min, max, default: fallback }) => {
  const value = Number(raw);
  return raw !== null && raw !== '' && Number.isFinite(value)
    ? Math.round(Math.max(min, Math.min(max, value)))
    : fallback;
};

const flag = (raw, fallback) => {
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (raw === 'true' || raw === 1 || raw === '1') {
    return true;
  }
  if (raw === 'false' || raw === 0 || raw === '0') {
    return false;
  }
  return fallback;
};

const secret = (raw) => String(raw ?? '').trim();

/**
 * The refresh token to use: the one Lightwave gave last when the user has
 * not pasted a new one since (the pasted one is the seed it came from),
 * else the pasted one.
 */
export function currentRefreshToken(raw = {}) {
  const pasted = secret(raw?.refresh_token);
  const state = readTokenState(raw?.[INTERNAL_KEYS.state]);
  return pasted !== '' && state && state.seed === seedHash(pasted) ? state.current : pasted;
}

export function normalizeConfig(raw = {}) {
  const apiToken = secret(raw?.api_token);
  const refreshToken = currentRefreshToken(raw);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  return {
    apiToken,
    refreshToken,
    /** The refresh token as the user pasted it (the seed of a rotation). */
    pastedRefreshToken: secret(raw?.refresh_token),
    /** The hash of the API token: the pauses and stops in /data belong to it. */
    account: apiToken === '' ? '' : accountKey(apiToken),
    pollInterval: bounded(raw?.poll_interval, POLL_INTERVAL),
    allowHeating: flag(raw?.allow_heating, DEFAULTS.allow_heating),
    maxSetpoint: bounded(raw?.max_setpoint, SETPOINT),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}
