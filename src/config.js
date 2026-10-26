// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized, plus the two
// keys the integration keeps in the Gladys configuration outside the schema
// (`setConfig`, never shown): the refresh token Lightwave gave last
// (`refresh_token_current`) and the one the user had pasted when it was
// obtained (`refresh_token_seed`). Lightwave gives a new refresh token at
// every renewal of the bearer token: it is kept in the Gladys database, as
// the secret fields are, never in /data.
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

/** The keys kept outside the schema. */
export const INTERNAL_KEYS = {
  seed: 'refresh_token_seed',
  current: 'refresh_token_current',
};

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
  const seed = secret(raw?.[INTERNAL_KEYS.seed]);
  const current = secret(raw?.[INTERNAL_KEYS.current]);
  return pasted !== '' && seed === pasted && current !== '' ? current : pasted;
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
