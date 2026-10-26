// -----------------------------------------------------------------------------
// The only network access: HTTPS requests to auth.lightwaverf.com and
// publicapi.lightwaverf.com, and the errors they end with. The body read is
// bounded, the promise settles once, redirects are never followed (a token
// replayed elsewhere), and nothing secret nor any free text of an answer goes
// into an error. Taken from gladys-leviton (approved).
// -----------------------------------------------------------------------------

import https from 'node:https';
import http from 'node:http';
import { LIMITS, TIMINGS } from './constants.js';

/**
 * A failed Lightwave call. `kind`:
 * - `no_credentials`: no API token or refresh token (never sent);
 * - `refused`: the token endpoint refused the API token or the refresh token (400, 401, 403);
 * - `token_rejected`: any other refusal of the token endpoint (the API changed);
 * - `unauthorized`: the API refused the bearer token (401);
 * - `forbidden`: a 403 of the API;
 * - `rate_limited`: 429, `retryAfter` in ms when given;
 * - `unavailable`: 5xx; `network`, `timeout`: no answer (`notSent`: it never left);
 * - `bad_response`, `size`: not the expected answer; `http`: any other status.
 */
export class LightwaveError extends Error {
  constructor(kind, message, { status, retryAfter, notSent } = {}) {
    super(message);
    this.name = 'LightwaveError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    this.notSent = Boolean(notSent);
  }
}

const NETWORK_REASONS = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

/** A socket error -> LightwaveError (never the request: it carries a token). */
export function networkError(err, notSent = false) {
  if (err instanceof LightwaveError) {
    return err;
  }
  return new LightwaveError('network', NETWORK_REASONS[err?.code] ?? 'network error', { notSent });
}

/** A short, secret-free reason for a log or a status message. */
export function errorReason(err) {
  if (err instanceof LightwaveError) {
    return err.status ? `${err.message} (HTTP ${err.status})` : err.message;
  }
  return 'unexpected error';
}

/**
 * One request; resolves `{ status, headers, body }` whatever the status.
 * `onSent` is called once the request has fully left (a command must know
 * whether it was sent); `sendWithin` (ms): a request that has not left by
 * then is destroyed and rejected unsent (a command is never sent late). A
 * new socket per request (`agent: false`): no kept-alive socket the server
 * may have closed meanwhile.
 */
export function httpRequest(
  url,
  {
    method = 'GET',
    headers = {},
    body,
    timeout = TIMINGS.requestTimeout,
    maxBytes = LIMITS.responseBytes,
    onSent,
    sendWithin,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    let timer;
    let sendTimer;
    let settled = false;
    let sent = false;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        clearTimeout(sendTimer);
        fn(value);
      }
    };
    const req = lib.request(target, { method, headers, agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          settle(reject, new LightwaveError('size', 'answer too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () =>
        settle(resolve, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      res.on('error', (err) => settle(reject, networkError(err)));
    });
    req.on('finish', () => {
      sent = true;
      clearTimeout(sendTimer);
      onSent?.();
    });
    if (sendWithin !== undefined) {
      sendTimer = setTimeout(
        () => {
          if (!sent) {
            settle(reject, new LightwaveError('timeout', 'not sent in time', { notSent: true }));
            req.destroy();
          }
        },
        Math.max(1, sendWithin),
      );
    }
    timer = setTimeout(
      () => {
        settle(
          reject,
          new LightwaveError('timeout', `no answer within ${Math.round(timeout / 1000)} s`, {
            notSent: !sent,
          }),
        );
        req.destroy();
      },
      Math.max(1, timeout),
    );
    req.on('error', (err) => settle(reject, networkError(err, !sent)));
    req.end(body);
  });
}

/** Retry-After (seconds or an HTTP date) -> milliseconds, undefined when absent. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The JSON of a body, `undefined` when empty; `bad_response` when it is not JSON. */
export function parseJson(body) {
  if (body === undefined || body === null || String(body).trim() === '') {
    return undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new LightwaveError('bad_response', 'Lightwave sent an answer that is not JSON');
  }
}

/** The transient errors shared by every call: 429, 5xx. Undefined otherwise. */
export function transientError({ status, headers = {} }, now) {
  if (status === 429) {
    return new LightwaveError('rate_limited', 'too many requests', {
      status,
      retryAfter: parseRetryAfter(headers['retry-after'], now),
    });
  }
  if (status >= 500) {
    return new LightwaveError('unavailable', 'Lightwave is unavailable', { status });
  }
  return undefined;
}

/** The error of a token endpoint answer, or undefined when it is a success. */
export function tokenError(answer, { now } = {}) {
  const { status } = answer;
  if (status >= 200 && status < 300) {
    return undefined;
  }
  const transient = transientError(answer, now);
  if (transient) {
    return transient;
  }
  if (status === 400 || status === 401 || status === 403) {
    return new LightwaveError('refused', 'API token or refresh token refused', { status });
  }
  return new LightwaveError('token_rejected', 'token request rejected', { status });
}

/** The error of an API answer (reads and commands), or undefined when it is a success. */
export function apiError(answer, { now } = {}) {
  const { status } = answer;
  if (status >= 200 && status < 300) {
    return undefined;
  }
  const transient = transientError(answer, now);
  if (transient) {
    return transient;
  }
  if (status === 401) {
    return new LightwaveError('unauthorized', 'bearer token refused', { status });
  }
  if (status === 403) {
    return new LightwaveError('forbidden', 'request refused', { status });
  }
  return new LightwaveError('http', 'request failed', { status });
}
