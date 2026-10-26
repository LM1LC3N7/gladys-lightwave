// -----------------------------------------------------------------------------
// The Lightwave account: the bearer token obtained from the API token and the
// refresh token (the token endpoint, as lightwave2's LWLink2Public), and the
// calls of the public API: the structures of the account, the feature sets
// of a structure, the values of features, the write of one feature.
//
// The bearer token lives in memory only; Lightwave gives a new refresh token
// with every bearer token, handed to `onToken` (the app keeps it in the
// Gladys configuration). A 401 of a read renews the token once and reads
// again, unless that token was just issued (the API then refuses the
// account: `api_refused`, never a renewal per cycle). A command never renews
// (it would leave late), except a protective one ("off", 5 °C), which renews
// and sends again on a 401. One renewal at a time, never in a loop: a
// refused one is final for these tokens.
// -----------------------------------------------------------------------------

import { API_ROOT, LIMITS, PATHS, TIMINGS, TOKEN_URL, USER_AGENT } from './constants.js';
import { LightwaveError, apiError, httpRequest, parseJson, tokenError } from './http.js';

/** The errors of one `features/read` request that leave the other requests going. */
const BATCH_LOCAL = new Set(['http', 'unavailable', 'network', 'timeout', 'bad_response', 'size']);

const refusedByApi = () =>
  new LightwaveError('api_refused', 'the API refused a new bearer token', { status: 401 });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A feature or feature set id of Lightwave: printable, bounded. */
export const validId = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_+-]{1,120}$/.test(value) ? value : undefined;

export class LightwaveClient {
  constructor({
    transport = httpRequest,
    now = Date.now,
    monotonic = () => performance.now(),
    onToken,
  } = {}) {
    this.transport = transport;
    this.now = now;
    this.monotonic = monotonic;
    this.onToken = onToken;
    this.apiToken = '';
    this.refreshToken = '';
    /** `{ accessToken, expiresAt }`, in memory only. */
    this.session = null;
    /** The renewal in progress, if any. */
    this.authenticating = undefined;
    /** A timeout for the requests of this cycle (the button), else the default. */
    this.timeout = undefined;
  }

  /** New tokens: the session is dropped (a bearer token of other tokens is not reused). */
  configure({ apiToken = '', refreshToken = '' }) {
    if (apiToken !== this.apiToken || refreshToken !== this.refreshToken) {
      this.session = null;
    }
    this.apiToken = apiToken;
    this.refreshToken = refreshToken;
  }

  get hasCredentials() {
    return this.apiToken !== '' && this.refreshToken !== '';
  }

  /** Whether the bearer token ends within its renewal margin (a tenth of its life, 5 min to 1 h). */
  needsRenewal(now = this.now()) {
    if (!this.session) {
      return true;
    }
    const { expiresAt, issuedAt } = this.session;
    const margin = Math.min(
      TIMINGS.tokenMarginMax,
      Math.max(TIMINGS.tokenMarginMin, (expiresAt - issuedAt) / 10),
    );
    return now >= expiresAt - margin;
  }

  headers(extra = {}) {
    return {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      ...extra,
    };
  }

  /** A new bearer token (one renewal at a time; a renewal running is joined). */
  refresh({ timeout } = {}) {
    if (!this.authenticating) {
      this.authenticating = this.renew({ timeout }).finally(() => {
        this.authenticating = undefined;
      });
    }
    return this.authenticating;
  }

  async renew({ timeout }) {
    if (!this.hasCredentials) {
      throw new LightwaveError('no_credentials', 'no API token or refresh token', {
        notSent: true,
      });
    }
    const { apiToken, refreshToken } = this;
    const body = JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken });
    const answer = await this.transport(TOKEN_URL, {
      method: 'POST',
      headers: this.headers({
        authorization: `basic ${apiToken}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      }),
      body,
      timeout: timeout ?? this.timeout ?? TIMINGS.requestTimeout,
    });
    if (apiToken !== this.apiToken || refreshToken !== this.refreshToken) {
      // Other tokens meanwhile: this answer is not theirs.
      throw new LightwaveError('network', 'tokens changed during the renewal', { notSent: true });
    }
    const error = tokenError(answer, { now: this.now() });
    if (error) {
      throw error;
    }
    const json = parseJson(answer.body);
    const accessToken =
      isObject(json) && typeof json.access_token === 'string' ? json.access_token : '';
    if (accessToken === '' || accessToken.length > 4096) {
      throw new LightwaveError('bad_response', 'no bearer token in the answer');
    }
    const now = this.now();
    const ttl =
      typeof json.expires_in === 'number' && json.expires_in > 0 && json.expires_in < 365 * 86_400
        ? json.expires_in * 1000
        : TIMINGS.tokenDefaultTtl;
    this.session = {
      accessToken,
      issuedAt: now,
      expiresAt: now + ttl,
      issuedMono: this.monotonic(),
    };
    const next = typeof json.refresh_token === 'string' ? json.refresh_token.trim() : '';
    if (next !== '' && next.length <= 4096 && next !== refreshToken) {
      this.refreshToken = next;
      await this.onToken?.(next, refreshToken);
    }
    return this.session;
  }

  /** A bearer token, renewed when missing or about to end (only when `allowRefresh`). */
  async ensureToken({ allowRefresh = true, timeout } = {}) {
    if (!this.hasCredentials) {
      throw new LightwaveError('no_credentials', 'no API token or refresh token', {
        notSent: true,
      });
    }
    if (this.session && !this.needsRenewal()) {
      return this.session.accessToken;
    }
    if (!allowRefresh) {
      if (this.session) {
        // About to end but still valid: a command uses it rather than waiting.
        return this.session.accessToken;
      }
      throw new LightwaveError('unauthorized', 'no bearer token yet', { notSent: true });
    }
    await this.refresh({ timeout });
    return this.session.accessToken;
  }

  /**
   * One API call; `retryAuth`: a 401 renews the token once and sends again.
   * A 401 on a bearer token issued less than 10 min ago is `api_refused`,
   * without a renewal. The JSON of the answer, `undefined` when empty.
   */
  async api(path, { method = 'GET', json, retryAuth = false, allowRefresh = true, ...rest } = {}) {
    const send = async (token) => {
      const body = json === undefined ? undefined : JSON.stringify(json);
      return this.transport(`${API_ROOT}${path}`, {
        method,
        headers: this.headers({
          authorization: `bearer ${token}`,
          ...(body === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
        }),
        body,
        timeout: rest.timeout ?? this.timeout ?? TIMINGS.requestTimeout,
        ...rest,
      });
    };
    const token = await this.ensureToken({ allowRefresh, timeout: rest.timeout });
    let used = this.session;
    let answer = await send(token);
    let error = apiError(answer, { now: this.now() });
    if (error?.kind === 'unauthorized') {
      if (this.isFresh(used)) {
        throw refusedByApi();
      }
      if (retryAuth && allowRefresh) {
        if (this.session === used) {
          // Only the token this call used is dropped: a token renewed meanwhile stays.
          this.session = null;
        }
        const renewed = await this.ensureToken({ timeout: rest.timeout });
        used = this.session;
        answer = await send(renewed);
        error = apiError(answer, { now: this.now() });
        if (error?.kind === 'unauthorized') {
          throw refusedByApi();
        }
      }
    }
    if (error) {
      throw error;
    }
    // The API took this bearer token once: a later 401 is a revocation (one
    // renewal), never an account without access.
    // Only the session whose token this answer took: never one renewed by
    // another call meanwhile.
    if (used) {
      used.accepted = true;
    }
    return parseJson(answer.body);
  }

  /**
   * Whether a session was issued less than `freshToken` ago (monotonic) and
   * never accepted by the API: a 401 on it means no access to the API.
   */
  isFresh(session) {
    return (
      Boolean(session) &&
      !session.accepted &&
      this.monotonic() - session.issuedMono < TIMINGS.freshToken
    );
  }

  /** The ids of the structures (homes) of the account. */
  async structures(options = {}) {
    const json = await this.api(PATHS.structures, { retryAuth: true, ...options });
    const list = isObject(json) && Array.isArray(json.structures) ? json.structures : undefined;
    if (!list) {
      throw new LightwaveError('bad_response', 'no structures in the answer');
    }
    return list.map(validId).filter(Boolean).slice(0, LIMITS.structures);
  }

  /** The devices and feature sets of a structure (raw, src/model.js reads it). */
  async structure(id, options = {}) {
    if (!validId(id)) {
      throw new LightwaveError('bad_response', 'invalid structure id', { notSent: true });
    }
    const json = await this.api(PATHS.structure(id), { retryAuth: true, ...options });
    if (!isObject(json) || !Array.isArray(json.devices)) {
      throw new LightwaveError('bad_response', 'no devices in the structure');
    }
    return json;
  }

  /**
   * The values of features, by id: 150 per request (as lightwave2), 10
   * requests at most (the ids beyond are `failed`, not read). A request that
   * fails on its own (5xx, network, bad answer) leaves its ids in `failed`
   * and the others go on; it throws only when every request failed, or on
   * an error of the account (401, 403, 429). A value that is not a finite
   * number is left out. `{ values, failed }`.
   */
  async readFeatures(ids, options = {}) {
    const values = new Map();
    const failed = new Set();
    const list = ids.filter(validId);
    const limit = LIMITS.featuresPerRead * LIMITS.readBatches;
    for (const id of list.slice(limit)) {
      failed.add(id);
    }
    let ok = 0;
    let first;
    for (let i = 0; i < Math.min(list.length, limit); i += LIMITS.featuresPerRead) {
      const chunk = list.slice(i, Math.min(i + LIMITS.featuresPerRead, limit));
      try {
        const json = await this.api(PATHS.read, {
          method: 'POST',
          json: { features: chunk.map((featureId) => ({ featureId })) },
          retryAuth: true,
          ...options,
        });
        if (!isObject(json)) {
          throw new LightwaveError('bad_response', 'the feature values are not an object');
        }
        for (const id of chunk) {
          const value = json[id];
          if (typeof value === 'number' && Number.isFinite(value)) {
            values.set(id, value);
          }
        }
        ok += 1;
      } catch (err) {
        if (!(err instanceof LightwaveError) || !BATCH_LOCAL.has(err.kind)) {
          throw err;
        }
        first ??= err;
        for (const id of chunk) {
          failed.add(id);
        }
      }
    }
    if (ok === 0 && first) {
      throw first;
    }
    return { values, failed };
  }

  /** The value of one feature. */
  async readFeature(id, options = {}) {
    if (!validId(id)) {
      throw new LightwaveError('bad_response', 'invalid feature id', { notSent: true });
    }
    const json = await this.api(PATHS.feature(id), { retryAuth: true, ...options });
    const value = isObject(json) ? json.value : undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new LightwaveError('bad_response', 'no value in the answer');
    }
    return value;
  }

  /**
   * Writes one feature (a command): never a renewal, sent once; a
   * `protective` one ("off", 5 °C) renews a missing token and sends again
   * once on a 401.
   */
  writeFeature(id, value, { protective = false, ...options } = {}) {
    if (!validId(id)) {
      return Promise.reject(
        new LightwaveError('bad_response', 'invalid feature id', { notSent: true }),
      );
    }
    return this.api(PATHS.feature(id), {
      method: 'POST',
      json: { value },
      allowRefresh: protective,
      retryAuth: protective,
      ...options,
    });
  }
}
