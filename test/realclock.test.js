// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and
// a real local HTTP server playing Lightwave: the reads really start, at 0,
// the interval and twice the interval, with a bounded number of timers. The
// time is sped up 20 times (30 s of the interval are 1.5 s) but it is the
// real clock: it moves between any two reads of it. Taken from gladys-iskra.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { LightwaveApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  API_TOKEN,
  REFRESH_TOKEN,
  STRUCTURES,
  defaultValues,
  homeStructure,
} from './fixtures/lightwave.js';

const SPEED = 20;
const INTERVAL = 30_000;

test('real clock: reads at 0, the interval and twice the interval; timers bounded', async () => {
  const values = defaultValues();
  const reads = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const json = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.method === 'POST' && req.url === '/token') {
        return json(200, { access_token: 'b', refresh_token: 'r2', expires_in: 86_400 });
      }
      if (req.url === '/v1/structures') {
        return json(200, { structures: [STRUCTURES.home] });
      }
      if (req.url === `/v1/structure/${STRUCTURES.home}`) {
        return json(200, homeStructure());
      }
      if (req.url === '/v1/features/read') {
        reads.push(performance.now() * SPEED);
        const out = {};
        for (const { featureId } of JSON.parse(body).features) {
          out[featureId] = values[featureId];
        }
        return json(200, out);
      }
      return json(404, {});
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  // The real transport, pointed at the local server whatever the host asked.
  const { httpRequest } = await import('../src/http.js');
  const transport = (url, options) => {
    const target = new URL(url);
    return httpRequest(`http://127.0.0.1:${port}${target.pathname}`, options);
  };
  let timersSet = 0;
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      return setTimeout(fn, Math.max(0, ms) / SPEED);
    },
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, Math.max(1, ms) / SPEED),
    clearInterval: (id) => clearInterval(id),
  };
  const config = { api_token: API_TOKEN, refresh_token: REFRESH_TOKEN, poll_interval: 30 };
  const gladys = createFakeGladys({ selector: 'lightwave', config });
  const quiet = () => {};
  const app = new LightwaveApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    transport,
    now: () => Date.now() * SPEED,
    monotonic: () => performance.now() * SPEED,
    timers,
    store: memoryStore(),
  });
  registerHandlers(gladys, app);
  const started = performance.now() * SPEED;
  try {
    await gladys.connect();
    const deadline = started + INTERVAL;
    while (reads.length === 0 && performance.now() * SPEED < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const until = (reads[0] ?? started) + 2.5 * INTERVAL;
    while (performance.now() * SPEED < until) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    app.stop();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const at = reads.map((t) => Math.round(t - started));
  assert.equal(reads.length, 3, `reads at ${at}`);
  assert.ok(reads[0] - started < INTERVAL / 2, `the first read at once: ${at}`);
  for (let i = 1; i < reads.length; i += 1) {
    const gap = reads[i] - reads[i - 1];
    assert.ok(gap >= 0.9 * INTERVAL, `never sooner than the interval: ${at}`);
    assert.ok(gap < 1.5 * INTERVAL, `on time: ${at}`);
  }
  assert.ok(timersSet <= 12, `${timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.ok(gladys.fake.discoveredDevices.length >= 5);
});
