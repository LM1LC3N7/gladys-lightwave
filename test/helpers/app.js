// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a fake Lightwave behind the
// transport and a virtual clock (the monotonic one moves 1 µs at every read,
// so that a decision reading it twice is caught). The real SDK wiring
// (src/handlers.js) is used.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { LightwaveApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { API_TOKEN, NOW, REFRESH_TOKEN } from '../fixtures/lightwave.js';
import { fakeLightwave, settle } from './fakeLightwave.js';
import { createFakeClock } from './fakeTimers.js';

export const SELECTOR = 'test-integration';
export const CONFIG = { api_token: API_TOKEN, refresh_token: REFRESH_TOKEN, language: 'en' };

/** The user saves the configuration: Gladys sends the whole of it back, internal keys included. */
export const save = (s, patch) =>
  s.gladys.fake.configUpdated({ ...s.gladys.fake.config, ...patch });
export const device = (id) => `ext:${SELECTOR}:device:${id}`;
export const feature = (id, key) => `${device(id)}:${key}`;

/** A logger keeping every line, to check that no secret ever reaches the logs. */
export const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

export async function setup({
  config = CONFIG,
  store = memoryStore(),
  server = fakeLightwave(),
  now = NOW,
  create = true,
  devices: known = [],
  logs = [],
  wall = { offset: 0 },
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices: known });
  const { clock, timers, advance } = createFakeClock(now);
  let drift = 0;
  const app = new LightwaveApp({
    gladys,
    logger: recorder(logs),
    transport: server.transport,
    now: () => clock.now + wall.offset,
    monotonic: () => clock.now + (drift += 0.001),
    timers,
    store,
  });
  registerHandlers(gladys, app);
  await gladys.connect();
  await advance(0);
  await settle();
  if (create) {
    for (const d of gladys.fake.discoveredDevices) {
      await gladys.fake.deviceCreated(d);
    }
    await settle();
  }
  const wait = async (ms) => {
    await advance(ms);
    await settle();
  };
  return { app, gladys, clock, server, store, logs, wait, advance, settle };
}

export { settle };
