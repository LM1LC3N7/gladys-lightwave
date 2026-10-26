// -----------------------------------------------------------------------------
// The Gladys features of each kind, their reads and the writes of a command
// (pure), the bounds of the heating, and the supported_options of the mode
// checked by the core's own validator when a Gladys clone is at hand.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig } from '../src/config.js';
import { MODE, OPENING, OPERATING, buildDevice, deviceStates, planOf } from '../src/devices.js';
import { kindOf, readStructure } from '../src/model.js';
import { SETS, STRUCTURES, homeStructure } from './fixtures/lightwave.js';

const CORE_NORMALIZE = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
const normalizeSupportedOptions = existsSync(CORE_NORMALIZE)
  ? createRequire(import.meta.url)(CORE_NORMALIZE).normalizeSupportedOptions
  : undefined;

const sets = readStructure(homeStructure(), STRUCTURES.home);
const setOf = (id) => sets.find((s) => s.id === id);
const plan = (id, language) => planOf(setOf(id), kindOf(setOf(id)), language);
const spec = (id, key) => plan(id).specs.find((s) => s.key === key);
const allowed = normalizeConfig({ allow_heating: true, max_setpoint: 23 });
const denied = normalizeConfig({});

test('the reads: scales, bounds, unknown values left out', () => {
  assert.equal(spec(SETS.trv, 'temperature').read({ temperature: 195 }), 19.5);
  assert.equal(spec(SETS.trv, 'temperature').read({ temperature: 1001 }), undefined);
  assert.equal(spec(SETS.trv, 'setpoint').read({ targetTemperature: 210 }), 21);
  assert.equal(spec(SETS.trv, 'heating').read({ valveLevel: 0 }), OPERATING.IDLE);
  assert.equal(spec(SETS.trv, 'heating').read({ valveLevel: 20 }), OPERATING.HEATING);
  assert.equal(spec(SETS.trv, 'heating').read({}), undefined);
  assert.equal(spec(SETS.boiler, 'heating').read({ callForHeat: 1 }), OPERATING.HEATING);
  assert.equal(spec(SETS.boiler, 'mode').read({ heatState: 2 }), undefined);
  assert.equal(spec(SETS.light, 'brightness').read({ dimLevel: 101 }), undefined);
  assert.equal(spec(SETS.light, 'watts').read({ power: -1 }), undefined);
  assert.equal(spec(SETS.window, 'opening').read({ windowPosition: 1 }), OPENING.OPEN);
  assert.equal(spec(SETS.window, 'opening').read({ windowPosition: 0 }), OPENING.CLOSE);
  assert.equal(spec(SETS.window, 'battery').read({ batteryLevel: 101 }), undefined);
  const gladys = createFakeGladys({ selector: 'lw' });
  const states = deviceStates(
    gladys,
    setOf(SETS.trv),
    { temperature: 200, valveLevel: 0 },
    plan(SETS.trv),
  );
  assert.deepEqual(
    states.map((s) => [s.device_feature_external_id.split(':').at(-1), s.state]),
    [
      ['temperature', 20],
      ['heating', 0],
    ],
  );
});

test('the writes: on/off, brightness, the heating behind the option and the ceiling', () => {
  assert.deepEqual(spec(SETS.socket, 'power').write(1), { writes: [{ type: 'switch', value: 1 }] });
  assert.deepEqual(spec(SETS.socket, 'power').write(0.5), { refuse: 'invalidValue' });
  assert.deepEqual(spec(SETS.light, 'brightness').write(30.4), {
    writes: [
      { type: 'dimLevel', value: 30 },
      { type: 'switch', value: 1 },
    ],
  });
  assert.deepEqual(spec(SETS.light, 'brightness').write(0), {
    writes: [{ type: 'switch', value: 0 }],
  });
  assert.deepEqual(spec(SETS.light, 'brightness').write(101), { refuse: 'invalidValue' });
  const setpoint = spec(SETS.trv, 'setpoint');
  assert.deepEqual(setpoint.write(21, {}, denied), { refuse: 'heatingDisabled' });
  assert.deepEqual(setpoint.write(21.5, {}, allowed), {
    writes: [{ type: 'targetTemperature', value: 215 }],
  });
  assert.deepEqual(setpoint.write(23.1, {}, allowed), { refuse: 'aboveMax' });
  assert.deepEqual(setpoint.write(4.9, {}, allowed), { refuse: 'belowMin' });
  assert.deepEqual(setpoint.write(NaN, {}, allowed), { refuse: 'invalidValue' });
  // The ceiling never exceeds Lightwave's 40 °C, whatever the configuration.
  const high = normalizeConfig({ allow_heating: true, max_setpoint: 99 });
  assert.equal(high.maxSetpoint, 40);
  assert.deepEqual(setpoint.write(40.5, {}, high), { refuse: 'aboveMax' });
  const mode = spec(SETS.boiler, 'mode');
  assert.deepEqual(mode.write(MODE.OFF, {}, denied), { writes: [{ type: 'heatState', value: 0 }] });
  assert.equal(mode.protective(MODE.OFF), true);
  assert.equal(mode.protective(MODE.HEATING), false);
  assert.deepEqual(mode.write(MODE.HEATING, {}, denied), { refuse: 'heatingDisabled' });
  assert.deepEqual(mode.write(MODE.HEATING, {}, allowed), {
    writes: [{ type: 'heatState', value: 1 }],
  });
  assert.deepEqual(mode.write(3, {}, allowed), { refuse: 'invalidValue' });
});

test('the plans: a radiator valve has no mode, a thermostat with heatState has one; a sensor-only set', () => {
  assert.deepEqual(
    plan(SETS.trv).specs.map((s) => s.key),
    ['temperature', 'setpoint', 'heating', 'battery'],
  );
  assert.deepEqual(
    plan(SETS.boiler).specs.map((s) => s.key),
    ['temperature', 'setpoint', 'mode', 'heating'],
  );
  assert.deepEqual(
    plan(SETS.window).specs.map((s) => s.key),
    ['opening', 'battery'],
  );
  assert.equal(planOf({ id: 'x', features: { movement: 'm' } }, 'sensor').specs[0].key, 'motion');
  assert.equal(planOf({ id: 'x', features: {} }, 'sensor'), undefined);
  assert.equal(planOf(setOf(SETS.hub), undefined), undefined);
});

test('the Gladys device: ids, units, read-only flags, string labels of the mode options', () => {
  const gladys = createFakeGladys({ selector: 'lw' });
  const device = buildDevice(gladys, setOf(SETS.boiler), plan(SETS.boiler, 'en'), 'en');
  assert.equal(device.external_id, `ext:lw:device:${SETS.boiler}`);
  assert.equal(device.should_poll, false);
  const mode = device.features.find((f) => f.external_id.endsWith(':mode'));
  assert.deepEqual(mode.supported_options, [
    { value: 0, label: 'Off' },
    { value: 1, label: 'Heating' },
  ]);
  for (const option of mode.supported_options) {
    assert.equal(typeof option.label, 'string');
  }
  if (normalizeSupportedOptions) {
    assert.doesNotThrow(() =>
      normalizeSupportedOptions(mode.supported_options, { category: 'thermostat', type: 'mode' }),
    );
  }
  const heating = device.features.find((f) => f.external_id.endsWith(':heating'));
  assert.equal(heating.read_only, true);
  assert.equal('unit' in heating, false);
  const setpoint = device.features.find((f) => f.external_id.endsWith(':setpoint'));
  assert.deepEqual(
    [setpoint.unit, setpoint.min, setpoint.max, setpoint.read_only],
    ['celsius', 5, 40, false],
  );
  for (const f of device.features) {
    assert.ok(f.name.length > 0 && f.name.length <= 100);
    assert.equal(f.has_feedback, true);
  }
});
