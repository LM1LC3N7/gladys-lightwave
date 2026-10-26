// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake Lightwave behind the transport, on a virtual clock whose
// monotonic reading moves at every call.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { ACTIONS } from '../src/constants.js';
import { INTERNAL_KEYS, seedHash, tokenState } from '../src/config.js';
import { memoryStore } from '../src/store.js';
import {
  API_TOKEN,
  FEATURE_IDS,
  HOUR,
  MINUTE,
  REFRESH_TOKEN,
  SECOND,
  SETS,
  STRUCTURES,
} from './fixtures/lightwave.js';
import { fakeLightwave } from './helpers/fakeLightwave.js';
import { CONFIG, currentOf, device, feature, save, setup } from './helpers/app.js';

const status = (s) => s.gladys.fake.connectionStatus;
const lastState = (s, id, key) => s.gladys.fake.lastState(feature(id, key));
const statesOf = (s, id, key) =>
  s.gladys.fake.states.filter((x) => x.device_feature_external_id === feature(id, key));
const setValue = (s, id, key, value) => {
  const d = s.gladys.fake.devices.find((x) => x.external_id === device(id));
  const f = d.features.find((x) => x.external_id === feature(id, key));
  return s.gladys.fake.setValue(d, f, value);
};
const badge = (s, id) =>
  s.gladys.fake.transports.findLast((t) => t.device_external_id === device(id))?.transport;

test('without tokens, the status asks for them and nothing is requested', async () => {
  const s = await setup({ config: {} });
  assert.equal(status(s).connected, false);
  assert.match(status(s).message.en, /API token/);
  assert.equal(s.server.requests.length, 0);
  await s.wait(10 * MINUTE);
  assert.equal(s.server.requests.length, 0);
});

test('the token endpoint, the structures, the values; the new refresh token saved in Gladys', async () => {
  const s = await setup();
  const [token] = s.server.tokens();
  assert.equal(token.headers.authorization, `basic ${API_TOKEN}`);
  assert.deepEqual(token.json, { grant_type: 'refresh_token', refresh_token: REFRESH_TOKEN });
  assert.equal(token.headers.accept, 'application/json');
  assert.equal(s.server.of('/v1/structures').length, 1);
  assert.equal(s.server.of(`/v1/structure/${STRUCTURES.home}`).length, 1);
  assert.equal(s.server.of(`/v1/structure/${STRUCTURES.cabin}`).length, 1);
  assert.equal(s.server.reads().length, 1);
  const read = s.server.reads()[0];
  assert.match(read.headers.authorization, /^bearer bearer1/);
  assert.equal(read.json.features.length, 17);
  assert.ok(
    !read.json.features.some((f) => f.featureId === FEATURE_IDS[SETS.hub].rgbColor),
    'only the features read',
  );
  assert.equal(status(s).connected, true);
  assert.match(status(s).message.en, /Connected to Lightwave: 6 device\(s\).*out of 8/);
  // The rotated refresh token lives in the Gladys configuration, never in /data.
  const config = s.gladys.fake.config;
  const state = JSON.parse(config[INTERNAL_KEYS.state]);
  assert.equal(state.seed, seedHash(REFRESH_TOKEN), 'a hash of the pasted token, never the token');
  assert.match(state.current, /^refresh1/);
  assert.ok(!config[INTERNAL_KEYS.state].includes(REFRESH_TOKEN));
  assert.equal(config.refresh_token, REFRESH_TOKEN, 'the pasted one is untouched');
  const data = JSON.stringify(s.store.data);
  for (const secret of s.server.secrets) {
    assert.ok(!data.includes(secret), 'no token in /data');
    assert.ok(!s.logs.join('\n').includes(secret), 'no token in the logs');
  }
});

test('the devices: light, socket, radiator valve, boiler thermostat, window sensor; hub and blind hidden', async () => {
  const s = await setup({ create: false });
  const list = s.gladys.fake.discoveredDevices;
  const byId = Object.fromEntries(list.map((d) => [d.external_id, d]));
  const keys = (id) => byId[device(id)].features.map((f) => f.external_id.split(':').at(-1));
  assert.deepEqual(keys(SETS.light), ['power', 'brightness', 'watts']);
  assert.deepEqual(keys(SETS.socket), ['power', 'watts']);
  assert.deepEqual(keys(SETS.trv), ['temperature', 'setpoint', 'heating', 'battery']);
  assert.deepEqual(keys(SETS.boiler), ['temperature', 'setpoint', 'mode', 'heating']);
  assert.deepEqual(keys(SETS.window), ['opening', 'battery']);
  assert.deepEqual(keys(SETS.cabinLight), ['power', 'brightness']);
  assert.equal(byId[device(SETS.hub)], undefined);
  assert.equal(byId[device(SETS.blind)], undefined);
  const light = byId[device(SETS.light)];
  assert.equal(light.name, 'Garden Room');
  assert.deepEqual(light.params, [
    { name: 'product_code', value: 'L22' },
    { name: 'structure', value: STRUCTURES.home },
    { name: 'lightwave_kind', value: 'light' },
  ]);
  const f = (id, key) => byId[device(id)].features.find((x) => x.external_id === feature(id, key));
  assert.deepEqual(
    [
      f(SETS.light, 'power').category,
      f(SETS.light, 'power').type,
      f(SETS.light, 'power').read_only,
    ],
    ['light', 'binary', false],
  );
  assert.deepEqual(
    [f(SETS.socket, 'power').category, f(SETS.socket, 'power').type],
    ['switch', 'binary'],
  );
  assert.deepEqual(
    [f(SETS.trv, 'setpoint').category, f(SETS.trv, 'setpoint').type, f(SETS.trv, 'setpoint').unit],
    ['thermostat', 'target-temperature', 'celsius'],
  );
  assert.deepEqual([f(SETS.trv, 'setpoint').min, f(SETS.trv, 'setpoint').max], [5, 40]);
  assert.equal(f(SETS.trv, 'heating').read_only, true);
  assert.deepEqual(
    f(SETS.boiler, 'mode').supported_options.map((o) => [o.value, o.label]),
    [
      [0, 'Off'],
      [1, 'Heating'],
    ],
  );
  assert.deepEqual(
    [f(SETS.window, 'opening').category, f(SETS.window, 'opening').type],
    ['opening-sensor', 'binary'],
  );
  assert.equal(f(SETS.light, 'watts').unit, 'watt');
  assert.equal(f(SETS.trv, 'battery').unit, 'percent');
});

test('the states: scales of Lightwave, badges cloud', async () => {
  const s = await setup();
  await s.wait(2 * SECOND);
  assert.equal(lastState(s, SETS.light, 'power'), 1);
  assert.equal(lastState(s, SETS.light, 'brightness'), 59);
  assert.equal(lastState(s, SETS.light, 'watts'), 12);
  assert.equal(lastState(s, SETS.socket, 'power'), 0);
  assert.equal(lastState(s, SETS.trv, 'temperature'), 19.5);
  assert.equal(lastState(s, SETS.trv, 'setpoint'), 21);
  assert.equal(lastState(s, SETS.trv, 'heating'), 1, 'the valve is open');
  assert.equal(lastState(s, SETS.trv, 'battery'), 87);
  assert.equal(lastState(s, SETS.boiler, 'mode'), 1);
  assert.equal(lastState(s, SETS.boiler, 'heating'), 0, 'no call for heat');
  assert.equal(lastState(s, SETS.boiler, 'setpoint'), 18);
  assert.equal(lastState(s, SETS.window, 'opening'), 0, 'Lightwave 1 = open, Gladys 0 = open');
  assert.equal(lastState(s, SETS.window, 'battery'), 100);
  assert.equal(badge(s, SETS.light), DEVICE_TRANSPORTS.CLOUD);
  assert.equal(badge(s, SETS.trv), DEVICE_TRANSPORTS.CLOUD);
});

test('one read of the values every 60 s, the structures once an hour, the token kept', async () => {
  const s = await setup();
  assert.equal(s.server.reads().length, 1);
  await s.wait(59 * SECOND);
  assert.equal(s.server.reads().length, 1);
  await s.wait(2 * SECOND);
  assert.equal(s.server.reads().length, 2);
  await s.wait(10 * MINUTE);
  assert.equal(s.server.reads().length, 12);
  assert.equal(s.server.of('/v1/structures').length, 1, 'the structures once an hour');
  assert.equal(s.server.tokens().length, 1, 'one token for the day');
  await s.wait(50 * MINUTE);
  assert.equal(s.server.of('/v1/structures').length, 2);
});

test('the interval follows the configuration, bounded to 30-300 s', async () => {
  const s = await setup({ config: { ...CONFIG, poll_interval: 30 } });
  await s.wait(5 * MINUTE);
  assert.equal(s.server.reads().length, 11);
  await save(s, { poll_interval: 1000 });
  await s.wait(10 * MINUTE);
  assert.equal(s.server.reads().length, 13);
});

test('the bearer token is renewed before its end, with the refresh token Lightwave gave last', async () => {
  const s = await setup({ server: fakeLightwave({ ttl: 3600 }) });
  await s.wait(50 * MINUTE);
  assert.equal(s.server.tokens().length, 1);
  await s.wait(6 * MINUTE);
  assert.equal(s.server.tokens().length, 2, 'renewed a tenth of its life (6 min) before the end');
  const [, second] = s.server.tokens();
  assert.match(second.json.refresh_token, /^refresh1/, 'the rotated one, not the pasted one');
  assert.match(currentOf(s.gladys.fake.config), /^refresh2/);
  assert.equal(status(s).connected, true);
});

test('a restart uses the rotated refresh token of the Gladys configuration', async () => {
  const s = await setup();
  const config = { ...s.gladys.fake.config };
  s.app.stop();
  const again = await setup({
    config,
    server: s.server,
    store: s.store,
    now: s.clock.now + 2 * MINUTE,
  });
  const [token] = again.server.tokens().slice(-1);
  assert.match(token.json.refresh_token, /^refresh1/);
  assert.equal(status(again).connected, true);
});

test('a refused refresh token stops for good, survives a restart; new tokens lift it', async () => {
  const s = await setup({ config: { ...CONFIG, refresh_token: 'spent-token' } });
  assert.equal(status(s).connected, false);
  assert.match(status(s).message.en, /refused the API token or the refresh token/);
  assert.equal(s.server.tokens().length, 1);
  await s.wait(24 * HOUR);
  assert.equal(s.server.tokens().length, 1, 'never tried again by itself');
  assert.equal(s.store.data.block.kind, 'refused');
  // The button does not retry a spent token either.
  assert.match((await s.gladys.fake.action(ACTIONS.TEST_CONNECTION)).data.message.en, /refused/);
  assert.equal(s.server.tokens().length, 1);
  // A restart with the same tokens stays stopped, without a request.
  s.app.stop();
  const again = await setup({
    config: { ...CONFIG, refresh_token: 'spent-token' },
    server: s.server,
    store: s.store,
    now: s.clock.now + 2 * MINUTE,
  });
  assert.equal(again.server.tokens().length, 1);
  assert.equal(status(again).connected, false);
  // New tokens pasted: one try, connected.
  await save(again, CONFIG);
  await again.wait(0);
  assert.equal(again.server.tokens().length, 2);
  assert.equal(status(again).connected, true);
  assert.equal(again.store.data.block, null);
});

test('a bearer token refused by the API: an old one is renewed once and the read again', async () => {
  const s = await setup();
  await s.wait(11 * MINUTE);
  s.server.revokeBearers();
  await s.wait(MINUTE);
  assert.equal(s.server.tokens().length, 2, 'one renewal');
  assert.equal(status(s).connected, true);
});

test('the API refusing every bearer token: no new token per cycle, unreachable, a stop at the 3rd', async () => {
  const s = await setup();
  s.server.before = (r) => {
    if (r.host === 'publicapi.lightwaverf.com') {
      s.server.revokeBearers();
    }
  };
  await s.wait(MINUTE);
  assert.equal(status(s).connected, false);
  assert.match(status(s).message.en, /refuses a bearer token it has just issued.*2 min/);
  assert.equal(badge(s, SETS.light), DEVICE_TRANSPORTS.UNREACHABLE);
  await s.wait(6 * HOUR);
  assert.ok(s.server.tokens().length <= 2, `${s.server.tokens().length} token requests in 6 h`);
  assert.match(status(s).message.en, /three times in a row/);
  assert.equal(s.store.data.block.kind, 'api_refused');
  // The button tries again, once.
  s.server.before = undefined;
  const result = await s.gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(result.data.message.en, /^Connected/);
  assert.equal(s.store.data.block, null);
});

test('the new refresh token not saved in Gladys: kept in memory, saved later, said in the status', async (t) => {
  const s = await setup({ create: false, server: fakeLightwave({ ttl: 3600 }) });
  const original = s.gladys.setConfig.bind(s.gladys);
  let fail = true;
  t.mock.method(s.gladys, 'setConfig', async (config) => {
    if (fail) throw new Error('Gladys unreachable');
    return original(config);
  });
  await s.wait(56 * MINUTE);
  assert.equal(s.server.tokens().length, 2);
  assert.match(status(s).message.en, /could not be saved in Gladys yet/);
  assert.equal(currentOf(s.gladys.fake.config).startsWith('refresh1'), true);
  // Gladys sends the configuration back meanwhile (a save by the user): the
  // token in memory is kept, no new renewal.
  await s.gladys.fake.configUpdated({ ...s.gladys.fake.config });
  await s.wait(0);
  assert.equal(s.server.tokens().length, 2);
  fail = false;
  await s.wait(MINUTE);
  assert.match(currentOf(s.gladys.fake.config), /^refresh2/);
  assert.doesNotMatch(status(s).message.en, /could not be saved/);
  // A page loaded before the rotation, saved now: its stale token is not
  // used, the right one is saved again.
  const stale = s.server.secrets.find((x) => x.startsWith('refresh1'));
  await s.gladys.fake.configUpdated({
    ...s.gladys.fake.config,
    [INTERNAL_KEYS.state]: tokenState(seedHash(REFRESH_TOKEN), stale),
    poll_interval: 120,
  });
  await s.wait(MINUTE);
  assert.equal(s.server.tokens().length, 2, 'no renewal with the stale token');
  assert.match(currentOf(s.gladys.fake.config), /^refresh2/);
  assert.equal(status(s).connected, true);
  // The rest of that save is applied: the new interval.
  assert.equal(s.app.config.pollInterval, 120);
});

test('commands: on/off, brightness (level then on, 0 turns off), read again 2 s later', async () => {
  const s = await setup();
  assert.deepEqual(await setValue(s, SETS.socket, 'power', 1), { success: true });
  let writes = s.server.writes();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, `/v1/feature/${FEATURE_IDS[SETS.socket].switch}`);
  assert.deepEqual(writes[0].json, { value: 1 });
  assert.equal(lastState(s, SETS.socket, 'power'), 1, 'shown at once');
  const reads = s.server.reads().length;
  await s.wait(2 * SECOND + 10);
  assert.equal(s.server.reads().length, reads + 1, 'read again');
  assert.deepEqual(await setValue(s, SETS.light, 'brightness', 30), { success: true });
  writes = s.server.writes();
  assert.deepEqual(
    writes.slice(-2).map((w) => w.json.value),
    [30, 1],
  );
  assert.equal(writes.at(-2).path, `/v1/feature/${FEATURE_IDS[SETS.light].dimLevel}`);
  assert.equal(lastState(s, SETS.light, 'brightness'), 30);
  assert.deepEqual(await setValue(s, SETS.light, 'brightness', 0), { success: true });
  assert.deepEqual(s.server.writes().at(-1).json, { value: 0 });
  assert.equal(s.server.writes().at(-1).path, `/v1/feature/${FEATURE_IDS[SETS.light].switch}`);
  assert.equal(lastState(s, SETS.light, 'power'), 0);
});

test('heating: refused until allowed; "off" always; the ceiling of the configuration', async () => {
  const s = await setup();
  let result = await setValue(s, SETS.trv, 'setpoint', 22);
  assert.equal(result.success, false);
  assert.match(result.error, /Allow the heating commands|Autoriser les commandes/);
  result = await setValue(s, SETS.boiler, 'mode', 1);
  assert.equal(result.success, false);
  assert.equal(s.server.writes().length, 0, 'nothing sent');
  // Off is the protective command: accepted whatever the option.
  assert.deepEqual(await setValue(s, SETS.boiler, 'mode', 0), { success: true });
  assert.deepEqual(s.server.writes().at(-1).json, { value: 0 });
  assert.equal(s.server.writes().at(-1).path, `/v1/feature/${FEATURE_IDS[SETS.boiler].heatState}`);
  assert.equal(lastState(s, SETS.boiler, 'mode'), 0);
  await save(s, { allow_heating: true, max_setpoint: 23 });
  assert.deepEqual(await setValue(s, SETS.trv, 'setpoint', 22.5), { success: true });
  assert.deepEqual(s.server.writes().at(-1).json, { value: 225 }, 'tenths of a degree');
  assert.equal(lastState(s, SETS.trv, 'setpoint'), 22.5);
  result = await setValue(s, SETS.trv, 'setpoint', 24);
  assert.equal(result.success, false);
  assert.match(result.error, /above the maximum/);
  result = await setValue(s, SETS.trv, 'setpoint', 4);
  assert.match(result.error, /below 5/);
  assert.deepEqual(await setValue(s, SETS.boiler, 'mode', 1), { success: true });
  assert.deepEqual(s.server.writes().at(-1).json, { value: 1 });
  // The option read right before the send: turned off meanwhile, refused.
  await save(s, { allow_heating: false });
  result = await setValue(s, SETS.trv, 'setpoint', 20);
  assert.equal(result.success, false);
});

test('commands refused: read-only feature, bad value, unknown feature, invalid mode', async () => {
  const s = await setup();
  const d = s.gladys.fake.devices.find((x) => x.external_id === device(SETS.trv));
  const heating = d.features.find((x) => x.external_id === feature(SETS.trv, 'heating'));
  let result = await s.gladys.fake.setValue(d, heating, 1);
  assert.match(result.error, /read only/);
  result = await setValue(s, SETS.socket, 'power', 2);
  assert.match(result.error, /Invalid value/);
  result = await setValue(s, SETS.socket, 'power', '');
  assert.match(result.error, /Invalid value/);
  result = await s.gladys.fake.setValue(
    d,
    { external_id: 'ext:test-integration:device:nope:power' },
    1,
  );
  assert.match(result.error, /Unknown device/);
  result = await setValue(s, SETS.boiler, 'mode', 2);
  assert.match(result.error, /Invalid value/);
  assert.equal(s.server.writes().length, 0);
});

test('commands of one device wait for each other; a slow one is answered at 4.3 s', async () => {
  const s = await setup();
  let release;
  s.server.before = (r) =>
    r.method === 'POST' && r.path.startsWith('/v1/feature/')
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
  const first = setValue(s, SETS.socket, 'power', 1);
  await s.settle();
  const second = setValue(s, SETS.socket, 'power', 0);
  await s.wait(4300);
  assert.deepEqual(await first, { success: true }, 'sent, answered without confirmation at 4.3 s');
  assert.equal(s.server.writes().length, 1);
  // The second one waited behind the first and could not leave within 3 s.
  const result = await second;
  assert.equal(result.success, false);
  assert.match(result.error, /Not sent/);
  release();
  await s.wait(SECOND);
  assert.equal(lastState(s, SETS.socket, 'power'), 1);
});

test('a command that cannot leave within 3 s is refused unsent', async () => {
  const s = await setup();
  s.server.beforeSent = () => new Promise(() => {});
  const pending = setValue(s, SETS.socket, 'power', 1);
  await s.wait(3 * SECOND + 100);
  const result = await pending;
  assert.equal(result.success, false);
  assert.match(result.error, /Not sent/);
  assert.equal(s.server.writes().length, 0);
});

test('a commanded value is held 15 s against a stale read, lifted by a read confirming it', async () => {
  const s = await setup();
  // The read after the command still shows the old value (Lightwave is slow).
  const switchId = FEATURE_IDS[SETS.socket].switch;
  s.server.before = (r) => {
    if (r.path === `/v1/feature/${switchId}` && r.method === 'POST') {
      setTimeout(() => {
        s.server.values[switchId] = 1;
      }, 0);
      s.server.values[switchId] = 0;
    }
  };
  s.server.values[switchId] = 0;
  await setValue(s, SETS.socket, 'power', 1);
  s.server.values[switchId] = 0;
  await s.wait(3 * SECOND);
  assert.equal(lastState(s, SETS.socket, 'power'), 1, 'the stale 0 is held back');
  s.server.values[switchId] = 1;
  await s.wait(MINUTE);
  assert.equal(lastState(s, SETS.socket, 'power'), 1);
  s.server.values[switchId] = 0;
  await s.wait(MINUTE);
  assert.equal(lastState(s, SETS.socket, 'power'), 0, 'after 15 s a read wins');
});

test('a refused or failed command says so; a 401 on a command never renews from the command', async () => {
  const s = await setup();
  s.server.queue.push({
    match: (r) => r.method === 'POST' && r.path.startsWith('/v1/feature/'),
    status: 403,
    body: {},
  });
  let result = await setValue(s, SETS.socket, 'power', 1);
  assert.match(result.error, /Refused by Lightwave \(request refused \(HTTP 403\)\)/);
  assert.equal(status(s).connected, true, 'a 403 of a command pauses nothing');
  s.server.queue.push({
    match: (r) => r.method === 'POST' && r.path.startsWith('/v1/feature/'),
    status: 500,
    body: {},
  });
  result = await setValue(s, SETS.socket, 'power', 1);
  assert.match(result.error, /Sent, without confirmation/);
  await s.wait(11 * MINUTE);
  const tokens = s.server.tokens().length;
  s.server.revokeBearers();
  result = await setValue(s, SETS.socket, 'power', 1);
  assert.match(result.error, /Refused by Lightwave \(bearer token refused/);
  assert.equal(s.server.tokens().length, tokens, 'no renewal from a command');
  await s.wait(MINUTE);
  assert.equal(s.server.tokens().length, tokens + 1, 'the next cycle renews');
  assert.equal(status(s).connected, true);
});

test('429: a bounded pause of every path, kept in /data, read back capped; "off" still goes', async () => {
  const s = await setup();
  s.server.queue.push({
    match: (r) => r.path === '/v1/features/read',
    status: 429,
    body: '',
    headers: { 'retry-after': '120' },
  });
  await s.wait(MINUTE);
  assert.equal(status(s).connected, true, 'still connected: Lightwave only asks to slow down');
  assert.match(status(s).message.en, /slow down.*2 min/);
  const reads = s.server.reads().length;
  let result = await setValue(s, SETS.socket, 'power', 1);
  assert.match(result.error, /slow down/);
  assert.match((await s.gladys.fake.action(ACTIONS.TEST_CONNECTION)).data.message.en, /slow down/);
  // The protective command goes through the pause (one try).
  result = await setValue(s, SETS.boiler, 'mode', 0);
  assert.equal(result.success, true);
  assert.equal(s.store.data.pause.kind, 'rate');
  await s.wait(MINUTE);
  assert.equal(s.server.reads().length, reads, 'paused');
  await s.wait(MINUTE + SECOND);
  assert.equal(s.server.reads().length, reads + 1, 'read again at the end of the pause');
  // Without Retry-After: 15 min; a huge one: 6 h at most.
  s.server.queue.push({
    match: (r) => r.path === '/v1/features/read',
    status: 429,
    body: '',
    headers: { 'retry-after': '100000' },
  });
  await s.wait(MINUTE);
  assert.match(status(s).message.en, /6 h/);
  // Read back from /data after a restart: capped at 6 h, kept across accounts.
  s.app.stop();
  const again = await setup({
    config: { ...CONFIG, api_token: 'other-token' },
    server: s.server,
    store: s.store,
    now: s.clock.now + 2 * MINUTE,
  });
  assert.match(status(again).message.en, /slow down/);
  assert.equal(
    again.server.tokens().length,
    s.server.tokens().length,
    'no request during the pause',
  );
});

test('403 of the reads: a one-hour pause of every path; 5xx and network: retried after 1, 2, 5… minutes', async () => {
  const s = await setup();
  s.server.queue.push({ match: (r) => r.path === '/v1/features/read', status: 403, body: {} });
  await s.wait(MINUTE);
  assert.equal(status(s).connected, false);
  assert.match(status(s).message.en, /HTTP 403.*60 min/);
  assert.equal(badge(s, SETS.light), DEVICE_TRANSPORTS.UNREACHABLE);
  await s.wait(HOUR + MINUTE);
  assert.equal(status(s).connected, true);
  assert.equal(badge(s, SETS.light), DEVICE_TRANSPORTS.CLOUD);
  s.server.down = true;
  await s.wait(MINUTE);
  assert.match(status(s).message.en, /not read \(connection refused\); new try in 1 min/);
  await s.wait(MINUTE);
  assert.match(status(s).message.en, /new try in 2 min/);
  await s.wait(2 * MINUTE);
  assert.match(status(s).message.en, /new try in 5 min/);
  s.server.down = false;
  await s.wait(5 * MINUTE);
  assert.equal(status(s).connected, true);
});

test('a structure that fails keeps its last devices (unreachable, not sent again), the others go on', async () => {
  const s = await setup();
  for (let i = 0; i < 8; i += 1) {
    s.server.queue.push({
      match: (r) => r.path === `/v1/structure/${STRUCTURES.cabin}`,
      status: 500,
      body: {},
    });
  }
  await s.wait(HOUR + MINUTE);
  s.server.values[FEATURE_IDS[SETS.cabinLight].dimLevel] = 40;
  s.server.values[FEATURE_IDS[SETS.light].dimLevel] = 41;
  await s.wait(MINUTE);
  assert.equal(status(s).connected, true);
  assert.match(status(s).message.en, /1 home\(s\) not read/);
  assert.equal(badge(s, SETS.cabinLight), DEVICE_TRANSPORTS.UNREACHABLE);
  assert.equal(badge(s, SETS.light), DEVICE_TRANSPORTS.CLOUD);
  assert.equal(lastState(s, SETS.light, 'brightness'), 41);
  assert.equal(lastState(s, SETS.cabinLight, 'brightness'), 100, 'its old value, not sent again');
  assert.ok(s.gladys.fake.discoveredDevices.some((d) => d.external_id === device(SETS.cabinLight)));
  const sent = statesOf(s, SETS.cabinLight, 'brightness').length;
  await s.wait(35 * MINUTE);
  assert.equal(statesOf(s, SETS.cabinLight, 'brightness').length, sent, 'heartbeat included');
  assert.ok(
    s.server.of(`/v1/structure/${STRUCTURES.cabin}`).length >= 8,
    'tried again every 5 min',
  );
  await s.wait(6 * MINUTE);
  assert.equal(badge(s, SETS.cabinLight), DEVICE_TRANSPORTS.CLOUD);
  assert.equal(lastState(s, SETS.cabinLight, 'brightness'), 40);
});

test('a reconnection to Gladys sends the status, the Discovery list and the badges again', async () => {
  const s = await setup();
  const before = s.gladys.fake.requests.length;
  await s.gladys.disconnect();
  await s.gladys.connect();
  await s.wait(0);
  const paths = s.gladys.fake.requests.slice(before).map((r) => `${r.method} ${r.path}`);
  assert.ok(
    paths.some((p) => /status/.test(p)),
    paths.join(', '),
  );
  assert.ok(
    paths.some((p) => /discover/.test(p)),
    paths.join(', '),
  );
  assert.ok(
    paths.some((p) => /transport/.test(p)),
    paths.join(', '),
  );
  assert.equal(s.server.tokens().length, 1, 'the token stays');
});

test('the Discovery list never shrinks, and created features are kept as Gladys has them', async () => {
  const s = await setup();
  const d = s.gladys.devices.find((x) => x.external_id === device(SETS.light));
  d.features[0].name = 'My own name';
  d.features[0].unit = null;
  delete s.server.structures[STRUCTURES.cabin];
  await s.wait(HOUR + MINUTE);
  await s.gladys.fake.scanRequest();
  const list = s.gladys.fake.discoveredDevices;
  assert.ok(
    list.some((x) => x.external_id === device(SETS.cabinLight)),
    'still offered',
  );
  const light = list.find((x) => x.external_id === device(SETS.light));
  assert.equal(light.features[0].name, 'My own name');
  assert.equal('unit' in light.features[0], false);
});

test('feature names follow the language of the configuration', async () => {
  const s = await setup({ config: { ...CONFIG, language: 'fr' }, create: false });
  const list = s.gladys.fake.discoveredDevices;
  const trv = list.find((x) => x.external_id === device(SETS.trv));
  assert.equal(
    trv.features.find((f) => f.external_id.endsWith(':setpoint')).name,
    'Température de consigne',
  );
  assert.equal(
    trv.features.find((f) => f.external_id.endsWith(':setpoint')).name.length <= 100,
    true,
  );
  const boiler = list.find((x) => x.external_id === device(SETS.boiler));
  assert.deepEqual(
    boiler.features
      .find((f) => f.external_id.endsWith(':mode'))
      .supported_options.map((o) => o.label),
    ['Arrêt', 'Chauffage'],
  );
});

test('the test button: never a read sooner than the interval, at most one click every 30 s', async () => {
  const s = await setup();
  const reads = s.server.reads().length;
  let result = await s.gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(result.data.message.en, /more recent than the interval.*60 s.*Connected/);
  assert.equal(s.server.reads().length, reads, 'no read sooner than the interval');
  result = await s.gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(result.data.message.en, /less than 30 seconds ago/);
  await s.wait(MINUTE);
  assert.equal(s.server.reads().length, reads + 1, 'the scheduled read came');
  // Lightwave down: a backoff; the click, once the interval has passed, reads at once.
  s.server.down = true;
  await s.wait(MINUTE);
  assert.match(status(s).message.en, /new try in 1 min/);
  s.server.down = false;
  await s.wait(31 * SECOND);
  result = await s.gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(result.data.message.en, /more recent than the interval/, 'the interval holds');
  await s.wait(30 * SECOND);
  // The scheduled new try came first (never two reads within the interval);
  // the failed attempt counts as a request of the fake.
  assert.equal(s.server.reads().length, reads + 3);
  result = await s.gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(result.data.message.en, /more recent than the interval.*Connected/);
  assert.equal(s.server.reads().length, reads + 3);
});

test('a rejected token request (not a refusal) stops until a click: the button or a save', async () => {
  const s = await setup({
    create: false,
    server: (() => {
      const f = fakeLightwave();
      f.queue.push({ match: (r) => r.host === 'auth.lightwaverf.com', status: 418, body: {} });
      return f;
    })(),
  });
  assert.equal(status(s).connected, false);
  assert.match(
    status(s).message.en,
    /Unexpected answer of the Lightwave token endpoint \(HTTP 418\)/,
  );
  await s.wait(HOUR);
  assert.equal(s.server.tokens().length, 1, 'no automatic new try');
  await s.wait(MINUTE);
  const result = await s.gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(result.data.message.en, /^Connected/);
  assert.equal(s.server.tokens().length, 2);
});

test('a restart never reads sooner than the interval after the last attempt', async () => {
  const s = await setup({ config: { ...CONFIG, poll_interval: 300 } });
  s.app.stop();
  const again = await setup({
    config: { ...s.gladys.fake.config },
    server: s.server,
    store: s.store,
    now: s.clock.now + MINUTE,
  });
  assert.equal(again.server.reads().length, 1, 'the read of before only');
  await again.wait(3 * MINUTE);
  assert.equal(again.server.reads().length, 1);
  await again.wait(MINUTE + SECOND);
  assert.equal(again.server.reads().length, 2);
});

test('a wall clock set back or forward never doubles or skips a read', async () => {
  const wall = { offset: 0 };
  const s = await setup({ wall });
  const reads = s.server.reads().length;
  wall.offset = -HOUR;
  await s.wait(2 * MINUTE);
  assert.equal(s.server.reads().length, reads + 2);
  wall.offset = 3 * HOUR;
  await s.wait(2 * MINUTE);
  assert.equal(s.server.reads().length, reads + 4);
});

test('another account: the devices of the previous one are not published again', async () => {
  const s = await setup();
  const other = fakeLightwave();
  other.apiToken = 'other-token';
  other.refreshTokens.add('other-refresh');
  delete other.structures[STRUCTURES.cabin];
  s.app.client.transport = other.transport;
  await save(s, { api_token: 'other-token', refresh_token: 'other-refresh' });
  await s.wait(2 * MINUTE);
  await s.gladys.fake.scanRequest();
  assert.ok(
    !s.gladys.fake.discoveredDevices.some((d) => d.external_id === device(SETS.cabinLight)),
  );
});

test('a bad answer: not JSON, no structures, values not an object', async () => {
  const s = await setup();
  s.server.queue.push({
    match: (r) => r.path === '/v1/features/read',
    status: 200,
    body: '<html>',
  });
  await s.wait(MINUTE);
  assert.match(status(s).message.en, /not JSON/);
  await s.wait(MINUTE);
  assert.equal(status(s).connected, true);
  s.server.queue.push({ match: (r) => r.path === '/v1/features/read', status: 200, body: '[]' });
  await s.wait(MINUTE);
  assert.match(status(s).message.en, /not an object/);
  await s.wait(6 * MINUTE);
  assert.equal(status(s).connected, true);
});

test('memoryStore and the fixtures are consistent (no secret shared with the logs by construction)', async () => {
  const store = memoryStore({ salt: 'a'.repeat(32) });
  const s = await setup({ store });
  assert.equal(s.store.data.salt, 'a'.repeat(32));
});
