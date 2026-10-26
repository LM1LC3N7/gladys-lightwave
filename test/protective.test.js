// -----------------------------------------------------------------------------
// The review points of r1 (2026-10-26), one scenario each: the protective
// commands after a restart and on a 401, their check by a read, a heating
// command in flight overtaken by an "off", the 5 °C of a radiator valve, the
// bounds of a huge account, stale values, a failing getConfig, grouped
// reads after commands, one failing batch.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { LightwaveApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { FEATURE_IDS, HOUR, MINUTE, SECOND, SETS } from './fixtures/lightwave.js';
import { fakeLightwave, settle } from './helpers/fakeLightwave.js';
import { CONFIG, device, feature, save, setup } from './helpers/app.js';

const status = (s) => s.gladys.fake.connectionStatus;
const command = (s, id, key, value) => {
  const d = s.gladys.fake.devices.find((x) => x.external_id === device(id));
  const f = d.features.find((x) => x.external_id === feature(id, key));
  return s.gladys.fake.setValue(d, f, value);
};
const writesOf = (s, featureId) =>
  s.server.writes().filter((w) => w.path === `/v1/feature/${featureId}`);
const HEAT = FEATURE_IDS[SETS.boiler].heatState;
const TARGET = FEATURE_IDS[SETS.trv].targetTemperature;

/** The same Gladys and Lightwave after a restart of the container, `after` ms later. */
const restart = async (s, after, extra = {}) => {
  s.app.stop();
  return setup({
    config: { ...s.gladys.fake.config, ...extra },
    server: s.server,
    store: s.store,
    devices: s.gladys.fake.devices,
    create: false,
    now: s.clock.now + after,
  });
};

test('S1a: a restart during a 429 pause kept in /data: "off" and 5 °C go out at once', async () => {
  const s = await setup();
  assert.ok(s.store.data.protect[SETS.boiler].heatState, 'the heating ids are kept in /data');
  s.server.queue.push({
    match: (r) => r.path === '/v1/features/read',
    status: 429,
    body: '',
    headers: { 'retry-after': '3600' },
  });
  await s.wait(MINUTE);
  const again = await restart(s, 5 * SECOND);
  assert.equal(again.server.reads().length, s.server.reads().length, 'no read: still paused');
  assert.deepEqual(await command(again, SETS.boiler, 'mode', 0), { success: true });
  assert.deepEqual(writesOf(again, HEAT).at(-1).json, { value: 0 });
  assert.equal(again.server.values[HEAT], 0);
  // A radiator valve: 5 °C, without the heating option.
  assert.deepEqual(await command(again, SETS.trv, 'setpoint', 5), { success: true });
  assert.deepEqual(writesOf(again, TARGET).at(-1).json, { value: 50 });
  // Anything else waits for the first read, with the real cause.
  const heat = await command(again, SETS.boiler, 'mode', 1);
  assert.match(heat.error, /until the first read since the start/);
  const light = await command(again, SETS.light, 'power', 1);
  assert.match(light.error, /not been read yet since the start/);
});

test('S1b: a restart within the interval: "off" goes out before the first read', async () => {
  const s = await setup({ config: { ...CONFIG, poll_interval: 300 } });
  await s.wait(20 * SECOND);
  const again = await restart(s, 0);
  assert.match(status(again).message.en, /Waiting for the first read/);
  assert.deepEqual(await command(again, SETS.boiler, 'mode', 0), { success: true });
  assert.equal(again.server.values[HEAT], 0);
  assert.equal(again.server.reads().length, s.server.reads().length, 'the interval holds');
});

test('S4b: "off" on a bearer token the API refuses: one renewal and sent again', async () => {
  const s = await setup();
  await s.wait(11 * MINUTE);
  s.server.revokeBearers();
  const tokens = s.server.tokens().length;
  assert.deepEqual(await command(s, SETS.boiler, 'mode', 0), { success: true });
  assert.equal(s.server.tokens().length, tokens + 1);
  assert.equal(writesOf(s, HEAT).length, 2, 'refused once, sent again');
  assert.equal(s.server.values[HEAT], 0);
});

test('S4a: "off" answered 200 but not applied: sent again (3 at most), the read shown, a warning', async () => {
  const s = await setup();
  let ignore = 2;
  s.server.applyWrite = (id) => !(id === HEAT && ignore-- > 0);
  assert.deepEqual(await command(s, SETS.boiler, 'mode', 0), { success: true });
  await s.wait(3 * SECOND);
  assert.match(status(s).message.en, /off \(or 5 °C\) sent is not what Lightwave reads back/);
  await s.wait(3 * SECOND);
  assert.equal(writesOf(s, HEAT).length, 3, 'sent again until it holds');
  assert.equal(s.server.values[HEAT], 0);
  await s.wait(5 * SECOND);
  assert.doesNotMatch(status(s).message.en, /not what Lightwave reads back/, 'confirmed by a read');
  assert.equal(s.gladys.fake.lastState(feature(SETS.boiler, 'mode')), 0);
  // Never applied: 3 resends, then the read is shown and the warning stays.
  s.server.applyWrite = (id) => id !== HEAT;
  s.server.values[HEAT] = 1;
  await s.wait(MINUTE);
  const before = writesOf(s, HEAT).length;
  await command(s, SETS.boiler, 'mode', 0);
  await s.wait(MINUTE);
  assert.equal(writesOf(s, HEAT).length, before + 4);
  assert.equal(s.gladys.fake.lastState(feature(SETS.boiler, 'mode')), 1, 'the read, not the wish');
  assert.match(status(s).message.en, /off \(or 5 °C\) sent is not what/);
});

test('S4c: a target answered 200 but not applied: a warning after 15 s', async () => {
  const s = await setup({ config: { ...CONFIG, allow_heating: true } });
  s.server.applyWrite = (id) => id !== TARGET;
  assert.deepEqual(await command(s, SETS.trv, 'setpoint', 22), { success: true });
  await s.wait(5 * SECOND);
  assert.doesNotMatch(status(s).message.en, /not what Lightwave reads back/);
  await s.wait(15 * SECOND);
  assert.match(status(s).message.en, /last command is not what Lightwave reads back 15 s later/);
  assert.equal(s.gladys.fake.lastState(feature(SETS.trv, 'setpoint')), 21);
  assert.equal(writesOf(s, TARGET).length, 1, 'a target is not sent again by itself');
});

test('S9: "heating" in flight then "off": the off is sent again after it, the off wins', async () => {
  const s = await setup({ config: { ...CONFIG, allow_heating: true } });
  await command(s, SETS.boiler, 'mode', 0);
  await s.wait(3 * SECOND);
  let release;
  s.server.before = (r) =>
    r.path === `/v1/feature/${HEAT}` && r.json?.value === 1
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
  const heat = command(s, SETS.boiler, 'mode', 1);
  await settle();
  await s.advance(300);
  assert.deepEqual(await command(s, SETS.boiler, 'mode', 0), { success: true });
  release();
  await settle();
  await s.wait(5 * SECOND);
  await heat;
  assert.deepEqual(
    writesOf(s, HEAT).map((w) => w.json.value),
    [0, 1, 0, 0],
  );
  assert.equal(s.server.values[HEAT], 0);
  assert.equal(s.gladys.fake.lastState(feature(SETS.boiler, 'mode')), 0);
});

test('a heating command still queued when an "off" arrives is cancelled, never sent', async () => {
  const s = await setup({ config: { ...CONFIG, allow_heating: true } });
  let release;
  s.server.before = (r) =>
    r.path === `/v1/feature/${TARGET}`
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
  const first = command(s, SETS.trv, 'setpoint', 22);
  await settle();
  const second = command(s, SETS.trv, 'setpoint', 23);
  await settle();
  s.server.before = undefined;
  assert.deepEqual(await command(s, SETS.trv, 'setpoint', 5), { success: true });
  release();
  await s.wait(5 * SECOND);
  await first;
  const result = await second;
  assert.match(result.error, /given after it on the same device cancels it/);
  assert.ok(!writesOf(s, TARGET).some((w) => w.json.value === 230));
  assert.equal(s.server.values[TARGET], 50);
});

test('5 °C of a radiator valve without the heating option is written; 6 °C is refused', async () => {
  const s = await setup();
  assert.deepEqual(await command(s, SETS.trv, 'setpoint', 5), { success: true });
  assert.deepEqual(writesOf(s, TARGET).at(-1).json, { value: 50 });
  const result = await command(s, SETS.trv, 'setpoint', 6);
  assert.match(result.error, /Allow the heating commands/);
  assert.equal(writesOf(s, TARGET).length, 1);
});

test('a huge account: 500 devices at most, 10 read requests per cycle at most', async () => {
  const server = fakeLightwave();
  const types = [
    'switch',
    'dimLevel',
    'power',
    'batteryLevel',
    'temperature',
    'humidity',
    'movement',
    'windowPosition',
    'callForHeat',
    'valveLevel',
    'heatState',
    'energy',
  ];
  server.structures = {};
  for (const structure of ['s1', 's2', 's3']) {
    const featureSets = [];
    for (let i = 0; i < 2200; i += 1) {
      const features = types.map((type, k) => ({ featureId: `${structure}-${i}-${k}`, type }));
      featureSets.push({ featureSetId: `${structure}-set-${i}`, name: `L ${i}`, features });
    }
    server.structures[structure] = { devices: [{ productCode: 'L22', featureSets }] };
  }
  const s = await setup({ server, create: false });
  assert.ok(s.app.sets.size <= 500, `${s.app.sets.size} sets kept`);
  assert.ok(s.server.reads().length <= 10, `${s.server.reads().length} read requests`);
  assert.match(status(s).message.en, /more device\(s\) not shown \(500 at most\)/);
  const reads = s.server.reads().length;
  await s.wait(MINUTE);
  assert.ok(s.server.reads().length - reads <= 10);
});

test('stale values are never published again: an update of the device or a reconnection after an outage', async () => {
  const s = await setup();
  await s.wait(2 * SECOND);
  s.server.down = true;
  await s.wait(3 * HOUR);
  const sent = s.gladys.fake.states.length;
  const d = s.gladys.fake.devices.find((x) => x.external_id === device(SETS.trv));
  await s.gladys.fake.deviceUpdated({ ...d, name: 'Renamed' });
  await s.wait(2 * SECOND);
  assert.equal(s.gladys.fake.states.length, sent, 'nothing republished after the update');
  await s.gladys.disconnect();
  await s.gladys.connect();
  await s.wait(2 * SECOND);
  assert.equal(s.gladys.fake.states.length, sent, 'nothing republished after the reconnection');
  s.server.down = false;
  await s.wait(16 * MINUTE);
  assert.ok(s.gladys.fake.states.length > sent, 'fresh values go again');
});

test('the second getConfig of the start failing: the integration starts anyway', async (t) => {
  const server = fakeLightwave();
  const gladys = createFakeGladys({ config: CONFIG });
  const original = gladys.getConfig.bind(gladys);
  let calls = 0;
  t.mock.method(gladys, 'getConfig', async () => {
    calls += 1;
    if (calls === 2) {
      throw new Error('Gladys busy');
    }
    return original();
  });
  const app = new LightwaveApp({
    gladys,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    transport: server.transport,
    store: memoryStore(),
    timers: globalThis,
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  await gladys.connect();
  for (let i = 0; i < 50 && server.reads().length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(calls, 2);
  assert.ok(server.tokens().length >= 1, 'Lightwave was contacted');
  assert.notEqual(gladys.fake.connectionStatus, undefined);
});

test('reads after commands are grouped: a scene of many commands, few reads', async () => {
  const s = await setup();
  const reads = s.server.reads().length;
  await Promise.all([
    command(s, SETS.socket, 'power', 1),
    command(s, SETS.light, 'power', 0),
    command(s, SETS.cabinLight, 'power', 1),
    command(s, SETS.light, 'brightness', 40),
  ]);
  await s.wait(3 * SECOND);
  assert.equal(s.server.reads().length, reads + 1, 'one grouped read');
});

test('one failing read request: the devices of the others are read, only its own unreachable', async () => {
  const server = fakeLightwave();
  // 200 lights in one structure: 400 features, 3 requests.
  const featureSets = [];
  for (let i = 0; i < 200; i += 1) {
    featureSets.push({
      featureSetId: `big-set-${i}`,
      name: `Light ${i}`,
      features: [
        { featureId: `big-${i}-s`, type: 'switch' },
        { featureId: `big-${i}-d`, type: 'dimLevel' },
      ],
    });
  }
  server.structures = { big: { devices: [{ productCode: 'L22', featureSets }] } };
  for (let i = 0; i < 200; i += 1) {
    server.values[`big-${i}-s`] = 1;
    server.values[`big-${i}-d`] = 50;
  }
  let n = 0;
  server.queue.push({
    match: (r) => r.path === '/v1/features/read' && ++n === 2,
    status: 500,
    body: {},
  });
  const s = await setup({ server });
  assert.equal(status(s).connected, true);
  assert.match(status(s).message.en, /device\(s\) not read this time/);
  const badges = new Map(s.gladys.fake.transports.map((t) => [t.device_external_id, t.transport]));
  assert.equal(badges.get(device('big-set-0')), DEVICE_TRANSPORTS.CLOUD);
  assert.equal(badges.get(device('big-set-100')), DEVICE_TRANSPORTS.UNREACHABLE);
  assert.equal(badges.get(device('big-set-199')), DEVICE_TRANSPORTS.CLOUD);
});

test('a structure id or feature id made of dots never reaches a path', async () => {
  const s = await setup({ create: false });
  const result = await s.app.client.readFeatures(['..', 'a:b', FEATURE_IDS[SETS.light].switch]);
  assert.deepEqual([...result.values.keys()], [FEATURE_IDS[SETS.light].switch]);
  await assert.rejects(s.app.client.structure('..'), { kind: 'bad_response' });
  await assert.rejects(s.app.client.writeFeature('..', 1), { kind: 'bad_response' });
  assert.ok(!s.server.requests.some((r) => r.path.includes('..')));
  await save(s, {});
});

// --- Review r2 ---------------------------------------------------------------

test('r2-1: refused tokens met by "off" during a 429 pause: kept, 6 offs = 1 token request', async () => {
  const s = await setup();
  s.server.queue.push({
    match: (r) => r.path === '/v1/features/read',
    status: 429,
    body: '',
    headers: { 'retry-after': '21600' },
  });
  await s.wait(MINUTE);
  // The refresh token is spent meanwhile (pasted again, refused by Lightwave).
  s.server.refreshTokens.clear();
  const again = await restart(s, 5 * SECOND, {
    refresh_token: 'spent-token',
    refresh_token_state: undefined,
  });
  const tokens = again.server.tokens().length;
  for (let i = 0; i < 6; i += 1) {
    const result = await command(again, SETS.boiler, 'mode', 0);
    assert.match(result.error, /Lightwave refused the tokens/);
    await again.wait(MINUTE);
  }
  assert.equal(again.server.tokens().length, tokens + 1, 'one token request for 6 offs');
  assert.equal(again.store.data.block.kind, 'refused');
  assert.match(status(again).message.en, /refused the API token or the refresh token/);
});

test('r2-1: an unexpected answer of the token endpoint met by "off": once a minute at most', async () => {
  const s = await setup();
  s.server.queue.push({
    match: (r) => r.path === '/v1/features/read',
    status: 429,
    body: '',
    headers: { 'retry-after': '21600' },
  });
  await s.wait(MINUTE);
  const again = await restart(s, 5 * SECOND);
  for (let i = 0; i < 3; i += 1) {
    again.server.queue.push({
      match: (r) => r.host === 'auth.lightwaverf.com',
      status: 403,
      body: '<html>Access denied (edge)</html>',
    });
  }
  const tokens = again.server.tokens().length;
  for (let i = 0; i < 6; i += 1) {
    await command(again, SETS.boiler, 'mode', 0);
    await again.wait(10 * SECOND);
  }
  assert.ok(
    again.server.tokens().length - tokens <= 2,
    `${again.server.tokens().length - tokens} requests in 1 min`,
  );
  assert.match(
    status(again).message.en,
    /Unexpected answer of the Lightwave token endpoint \(HTTP 403\)/,
  );
  assert.equal(again.store.data.block, null, 'not a persisted stop: the tokens may be good');
});

test('r2-2: a bearer token the API accepted, revoked a minute later: renewed, "off" sent again', async () => {
  const s = await setup();
  await s.wait(MINUTE);
  s.server.revokeBearers();
  const tokens = s.server.tokens().length;
  assert.deepEqual(await command(s, SETS.boiler, 'mode', 0), { success: true });
  assert.equal(s.server.tokens().length, tokens + 1);
  assert.equal(s.server.values[HEAT], 0);
  await s.wait(MINUTE);
  assert.equal(status(s).connected, true);
});

test('r2-3: the heating ids of another account are never used', async () => {
  const s = await setup();
  s.server.apiToken = 'other-token';
  s.server.refreshTokens.add('other-refresh');
  // Another account: other homes.
  s.server.structures = { 'other-home': { devices: [] } };
  const again = await restart(s, 5 * SECOND, {
    api_token: 'other-token',
    refresh_token: 'other-refresh',
    refresh_token_state: undefined,
  });
  const writes = again.server.writes().length;
  const result = await command(again, SETS.boiler, 'mode', 0);
  assert.match(result.error, /not in the homes of the Lightwave account configured now/);
  assert.equal(again.server.writes().length, writes);
});

test('r2-4: an empty list of structures does not wipe the heating ids', async () => {
  const s = await setup();
  s.server.structures = {};
  await s.wait(HOUR + MINUTE);
  assert.ok(s.store.data.protect[SETS.boiler], 'still kept');
  const again = await restart(s, 5 * SECOND);
  assert.deepEqual(await command(again, SETS.boiler, 'mode', 0), { success: true });
});

test('r2-5: beyond 1 500 features, every device is read in turn', async () => {
  const server = fakeLightwave();
  const featureSets = [];
  for (let i = 0; i < 500; i += 1) {
    const features = [
      'temperature',
      'targetTemperature',
      'valveLevel',
      'valveSetup',
      'batteryLevel',
    ].map((type, k) => ({ featureId: `v-${i}-${k}`, type }));
    for (const f of features)
      server.values[f.featureId] = f.type === 'targetTemperature' ? 200 : 50;
    featureSets.push({ featureSetId: `valve-${i}`, name: `Valve ${i}`, features });
  }
  server.structures = { big: { devices: [{ productCode: 'LW922', featureSets }] } };
  const s = await setup({ server, create: false });
  await s.wait(3 * MINUTE);
  assert.equal(s.app.readAt.size, 500, 'every valve read at least once');
  assert.ok(s.server.reads().length <= 40);
});

// --- Review r3 ---------------------------------------------------------------

test('r3-1: a new API token of the same account: "off" goes out at once, even during a 429 pause', async () => {
  const s = await setup({ config: { ...CONFIG, poll_interval: 300 } });
  s.server.queue.push({
    match: (r) => r.path === '/v1/features/read',
    status: 429,
    body: '',
    headers: { 'retry-after': '3600' },
  });
  await s.wait(5 * MINUTE + SECOND);
  s.server.apiToken = 'same-account-new-token';
  s.server.refreshTokens.add('same-account-refresh');
  const again = await restart(s, 10 * SECOND, {
    api_token: 'same-account-new-token',
    refresh_token: 'same-account-refresh',
    refresh_token_state: undefined,
  });
  assert.deepEqual(await command(again, SETS.boiler, 'mode', 0), { success: true });
  assert.equal(again.server.values[HEAT], 0);
  assert.equal(
    again.store.data.protectAccount,
    again.app.config.account,
    "the table is this account's now",
  );
  // Checked once: the next "off" needs no read of the structures.
  const lists = again.server.of('/v1/structures').length;
  assert.deepEqual(await command(again, SETS.trv, 'setpoint', 5), { success: true });
  assert.equal(again.server.of('/v1/structures').length, lists);
});

test('r3-2: beyond 1 500 features, a device skipped by the rotation keeps its badge', async () => {
  const server = fakeLightwave();
  const featureSets = [];
  for (let i = 0; i < 500; i += 1) {
    const features = ['temperature', 'targetTemperature', 'valveLevel', 'batteryLevel'].map(
      (type, k) => ({ featureId: `w-${i}-${k}`, type }),
    );
    for (const f of features) server.values[f.featureId] = 50;
    featureSets.push({ featureSetId: `wv-${i}`, name: `Valve ${i}`, features });
  }
  server.structures = { big: { devices: [{ productCode: 'LW922', featureSets }] } };
  const s = await setup({ server });
  await s.wait(2 * MINUTE);
  const before = s.gladys.fake.transports.length;
  await s.wait(4 * MINUTE);
  const flips = s.gladys.fake.transports.slice(before);
  assert.equal(flips.length, 0, `${flips.length} badge changes in 4 cycles`);
  assert.doesNotMatch(s.gladys.fake.connectionStatus.message.en, /not read this time/);
});

test('r3-3: "accepted" marks only the session that answered', async () => {
  const server = fakeLightwave();
  const { LightwaveClient } = await import('../src/client.js');
  const { API_TOKEN, REFRESH_TOKEN } = await import('./fixtures/lightwave.js');
  const client = new LightwaveClient({ transport: server.transport });
  client.configure({ apiToken: API_TOKEN, refreshToken: REFRESH_TOKEN });
  await client.refresh();
  let release;
  server.before = (r) =>
    r.path === '/v1/structures'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
  const first = client.structures();
  await settle();
  // Another call renews meanwhile.
  client.session = null;
  server.before = undefined;
  await client.refresh();
  const renewed = client.session;
  release();
  await first;
  assert.notEqual(renewed.accepted, true, 'the new session has not been used yet');
});
