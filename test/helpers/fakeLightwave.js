// -----------------------------------------------------------------------------
// A fake Lightwave behind the transport the integration is given: the token
// endpoint (a bearer token and a NEW refresh token from the API token and the
// refresh token; a refresh token is spent once used), the structures, the
// feature values and the writes. Records every request. No network.
// -----------------------------------------------------------------------------

import { LightwaveError } from '../../src/http.js';
import {
  API_TOKEN,
  REFRESH_TOKEN,
  STRUCTURES,
  cabinStructure,
  defaultValues,
  homeStructure,
} from '../fixtures/lightwave.js';

const answer = (status, body, headers = {}) => ({
  status,
  headers,
  body: body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body),
});

export function fakeLightwave({ ttl = 86_400 } = {}) {
  const server = {
    apiToken: API_TOKEN,
    /** The refresh tokens Lightwave accepts now (the pasted one, then each new one). */
    refreshTokens: new Set([REFRESH_TOKEN]),
    ttl,
    structures: {
      [STRUCTURES.home]: homeStructure(),
      [STRUCTURES.cabin]: cabinStructure(),
    },
    values: defaultValues(),
    /** { method, path, headers, json } */
    requests: [],
    bearers: new Set(),
    issued: 0,
    /** Every secret ever issued or accepted, to check none reaches the logs. */
    secrets: [API_TOKEN, REFRESH_TOKEN],
    down: false,
    /** One-shot answers: { match(request), status, body, headers } */
    queue: [],
    /** Called with each request before it is answered (may wait). */
    before: undefined,
    /** Whether a write answered 200 is applied (false: Lightwave answers but keeps the old value). */
    applyWrite: () => true,
    of(path, method) {
      return this.requests.filter((r) => r.path === path && (!method || r.method === method));
    },
    tokens() {
      return this.requests.filter((r) => r.host === 'auth.lightwaverf.com');
    },
    reads() {
      return this.of('/v1/features/read', 'POST');
    },
    writes() {
      return this.requests.filter((r) => r.method === 'POST' && /^\/v1\/feature\//.test(r.path));
    },
    revokeBearers() {
      this.bearers.clear();
    },
    issue() {
      this.issued += 1;
      const bearer = `bearer${this.issued}${Math.random().toString(36).slice(2)}`;
      const refresh = `refresh${this.issued}${Math.random().toString(36).slice(2)}`;
      this.secrets.push(bearer, refresh);
      this.bearers.add(bearer);
      this.refreshTokens.add(refresh);
      return { bearer, refresh };
    },
  };

  server.transport = async (
    url,
    { method = 'GET', headers = {}, body, onSent, sendWithin } = {},
  ) => {
    const target = new URL(url);
    const request = {
      method,
      host: target.host,
      path: target.pathname,
      headers,
      json: body ? JSON.parse(body) : undefined,
    };
    // `beforeSent` may hold the request before it leaves (a slow connection):
    // past `sendWithin`, it never leaves, as the real transport.
    if (server.beforeSent) {
      let handle;
      const left = await Promise.race([
        server.beforeSent(request).then(() => true),
        sendWithin === undefined
          ? new Promise(() => {})
          : new Promise((resolve) => {
              handle = setTimeout(() => resolve(false), sendWithin);
            }),
      ]);
      clearTimeout(handle);
      if (!left) {
        throw new LightwaveError('timeout', 'not sent in time', { notSent: true });
      }
    }
    server.requests.push(request);
    onSent?.();
    await server.before?.(request);
    if (server.down) {
      throw new LightwaveError('network', 'connection refused', { notSent: true });
    }
    const forced = server.queue.findIndex((q) => q.match(request));
    if (forced >= 0) {
      const [{ status, body: forcedBody, headers: forcedHeaders }] = server.queue.splice(forced, 1);
      return answer(status, forcedBody, forcedHeaders);
    }
    if (
      target.host === 'auth.lightwaverf.com' &&
      method === 'POST' &&
      target.pathname === '/token'
    ) {
      const { grant_type: grant, refresh_token: refresh } = request.json ?? {};
      if (headers.authorization !== `basic ${server.apiToken}`) {
        return answer(401, { message: 'Unauthorized' });
      }
      if (grant !== 'refresh_token' || !server.refreshTokens.has(refresh)) {
        return answer(400, { error: 'invalid_grant' });
      }
      // Spent: Lightwave gives a new one with the bearer token.
      server.refreshTokens.delete(refresh);
      const { bearer, refresh: next } = server.issue();
      return answer(200, {
        access_token: bearer,
        refresh_token: next,
        token_type: 'bearer',
        expires_in: server.ttl,
      });
    }
    if (target.host !== 'publicapi.lightwaverf.com') {
      return answer(404, 'not found');
    }
    const bearer = /^bearer (.+)$/i.exec(headers.authorization ?? '')?.[1];
    if (!bearer || !server.bearers.has(bearer)) {
      return answer(401, { message: 'Unauthorized' });
    }
    const path = request.path;
    if (method === 'GET' && path === '/v1/structures') {
      return answer(200, { structures: Object.keys(server.structures) });
    }
    let match = /^\/v1\/structure\/([^/]+)$/.exec(path);
    if (method === 'GET' && match) {
      const structure = server.structures[match[1]];
      return structure ? answer(200, structure) : answer(404, { message: 'Not found' });
    }
    if (method === 'POST' && path === '/v1/features/read') {
      const out = {};
      for (const { featureId } of request.json?.features ?? []) {
        if (featureId in server.values) {
          out[featureId] = server.values[featureId];
        }
      }
      return answer(200, out);
    }
    match = /^\/v1\/feature\/([^/]+)$/.exec(path);
    if (match) {
      const id = match[1];
      if (!(id in server.values)) {
        return answer(404, { message: 'Not found' });
      }
      if (method === 'GET') {
        return answer(200, { value: server.values[id] });
      }
      if (method === 'POST') {
        if (server.applyWrite(id, request.json?.value, request) !== false) {
          server.values[id] = request.json?.value;
        }
        return answer(200, { value: request.json?.value });
      }
    }
    return answer(404, { message: 'Not found' });
  };

  return server;
}

/** Lets the pending promises settle (no timer involved). */
export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
