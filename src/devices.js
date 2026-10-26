// -----------------------------------------------------------------------------
// A Lightwave feature set -> one Gladys device: its features, how each one is
// read from the values of the set, and how a command becomes the writes of
// `POST /feature/<id>` (pure).
//
// External ids: `ext:<selector>:device:<featureSetId>`, features by role:
// `power`, `brightness`, `temperature`, `setpoint`, `mode`, `heating`,
// `watts`, `battery`, `opening`, `motion`, `humidity`. Never change how they
// are built.
//
// Scales (the Home Assistant integration of lightwave2): `temperature` and
// `targetTemperature` in tenths of a degree Celsius, `dimLevel` 0-100,
// `switch` and `heatState` 0/1, `valveLevel` 0-100, `callForHeat` 0/1,
// `power` in W, `batteryLevel` and `humidity` in %, `windowPosition` and
// `movement` 0/1 (1 = open, moving).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FEATURES as F, SETPOINT } from './constants.js';
import { FEATURE_NAMES, MODE_NAMES, word } from './i18n.js';

/** THERMOSTAT_MODE of the core: off, heating. */
export const MODE = { OFF: 0, HEATING: 1 };
/** THERMOSTAT_OPERATING_STATE of the core: idle, heating. */
export const OPERATING = { IDLE: 0, HEATING: 1 };
/** OPENING_SENSOR_STATE of the core: 0 = open, 1 = closed. */
export const OPENING = { OPEN: 0, CLOSE: 1 };

const within = (value, min, max) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;
const bit = (value) => (value === 0 || value === 1 ? value : undefined);
/** Tenths of a degree -> °C, within -50..100 °C. */
const tenths = (value) => {
  const degrees = within(value, -500, 1000);
  return degrees === undefined ? undefined : Math.round(degrees) / 10;
};

const onOff = (v) => {
  if (v !== 0 && v !== 1) {
    return { refuse: 'invalidValue' };
  }
  return { writes: [{ type: F.SWITCH, value: v }] };
};

const spec = (key, name, category, type, extra) => ({ key, name, category, type, ...extra });

const powerSpec = (category, type) =>
  spec('power', 'power', category, type, {
    min: 0,
    max: 1,
    read: (v) => bit(v[F.SWITCH]),
    write: (v) => onOff(v),
  });

const brightnessSpec = () =>
  spec('brightness', 'brightness', C.LIGHT, T.LIGHT.BRIGHTNESS, {
    min: 0,
    max: 100,
    read: (v) => within(v[F.DIM_LEVEL], 0, 100),
    // 0 turns the light off; otherwise the level, then on (lightwave2 sets
    // the level then the switch).
    write: (v) => {
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        return { refuse: 'invalidValue' };
      }
      const level = Math.round(v);
      if (level <= 0) {
        return { writes: [{ type: F.SWITCH, value: 0 }] };
      }
      return {
        writes: [
          { type: F.DIM_LEVEL, value: level },
          { type: F.SWITCH, value: 1 },
        ],
      };
    },
  });

const temperatureSpec = () =>
  spec('temperature', 'temperature', C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, {
    unit: U.CELSIUS,
    min: -50,
    max: 100,
    read: (v) => tenths(v[F.TEMPERATURE]),
  });

/**
 * The target temperature: written only when the configuration allows the
 * heating commands, within 5 °C and the ceiling of the configuration (40 °C
 * at most, Lightwave's own limit).
 */
const setpointSpec = () =>
  spec('setpoint', 'setpoint', C.THERMOSTAT, T.THERMOSTAT.TARGET_TEMPERATURE, {
    unit: U.CELSIUS,
    min: SETPOINT.min,
    max: SETPOINT.max,
    read: (v) => tenths(v[F.TARGET_TEMPERATURE]),
    write: (v, _values, config) => {
      if (!Number.isFinite(v)) {
        return { refuse: 'invalidValue' };
      }
      if (!config.allowHeating) {
        return { refuse: 'heatingDisabled' };
      }
      const max = Math.min(SETPOINT.max, config.maxSetpoint);
      if (v < SETPOINT.min) {
        return { refuse: 'belowMin' };
      }
      if (v > max) {
        return { refuse: 'aboveMax' };
      }
      return { writes: [{ type: F.TARGET_TEMPERATURE, value: Math.round(v * 10) }] };
    },
  });

/** Off (always allowed: the protective command) or heating (with the option). */
const modeSpec = (language) =>
  spec('mode', 'mode', C.THERMOSTAT, T.THERMOSTAT.MODE, {
    min: MODE.OFF,
    max: MODE.HEATING,
    supported_options: [MODE.OFF, MODE.HEATING].map((value) => ({
      value,
      label: word(MODE_NAMES[value], language),
    })),
    read: (v) => bit(v[F.HEAT_STATE]),
    protective: (v) => v === MODE.OFF,
    write: (v, _values, config) => {
      if (v === MODE.OFF) {
        return { writes: [{ type: F.HEAT_STATE, value: 0 }] };
      }
      if (v === MODE.HEATING) {
        return config.allowHeating
          ? { writes: [{ type: F.HEAT_STATE, value: 1 }] }
          : { refuse: 'heatingDisabled' };
      }
      return { refuse: 'invalidValue' };
    },
  });

/** Whether the device is heating now: the valve open, or a call for heat. */
const operatingSpec = (set) =>
  spec('heating', 'heating', C.THERMOSTAT, T.THERMOSTAT.OPERATING_STATE, {
    min: OPERATING.IDLE,
    max: OPERATING.HEATING,
    read: (v) => {
      if (F.VALVE_LEVEL in set.features) {
        const level = within(v[F.VALVE_LEVEL], 0, 100);
        return level === undefined ? undefined : level > 0 ? OPERATING.HEATING : OPERATING.IDLE;
      }
      if (F.CALL_FOR_HEAT in set.features) {
        const call = bit(v[F.CALL_FOR_HEAT]);
        return call === undefined ? undefined : call === 1 ? OPERATING.HEATING : OPERATING.IDLE;
      }
      return undefined;
    },
  });

const wattsSpec = () =>
  spec('watts', 'watts', C.ENERGY_SENSOR, T.ENERGY_SENSOR.POWER, {
    unit: U.WATT,
    min: 0,
    max: 100_000,
    read: (v) => within(v[F.POWER], 0, 100_000),
  });

const batterySpec = () =>
  spec('battery', 'battery', C.BATTERY, T.BATTERY.INTEGER, {
    unit: U.PERCENT,
    min: 0,
    max: 100,
    read: (v) => within(v[F.BATTERY_LEVEL], 0, 100),
  });

const openingSpec = () =>
  spec('opening', 'opening', C.OPENING_SENSOR, T.SENSOR.BINARY, {
    min: 0,
    max: 1,
    // Lightwave: 1 = open; Gladys: 0 = open, 1 = closed.
    read: (v) => {
      const open = bit(v[F.WINDOW_POSITION]);
      return open === undefined ? undefined : open === 1 ? OPENING.OPEN : OPENING.CLOSE;
    },
  });

const motionSpec = () =>
  spec('motion', 'motion', C.MOTION_SENSOR, T.SENSOR.BINARY, {
    min: 0,
    max: 1,
    read: (v) => bit(v[F.MOVEMENT]),
  });

const humiditySpec = () =>
  spec('humidity', 'humidity', C.HUMIDITY_SENSOR, T.SENSOR.DECIMAL, {
    unit: U.PERCENT,
    min: 0,
    max: 100,
    read: (v) => within(v[F.HUMIDITY], 0, 100),
  });

/** The readings any kind of set may carry, when the set has the feature. */
function extraSpecs(set) {
  const specs = [];
  const has = (type) => type in set.features;
  if (has(F.WINDOW_POSITION)) specs.push(openingSpec());
  if (has(F.MOVEMENT)) specs.push(motionSpec());
  if (has(F.HUMIDITY)) specs.push(humiditySpec());
  if (has(F.POWER)) specs.push(wattsSpec());
  if (has(F.BATTERY_LEVEL)) specs.push(batterySpec());
  return specs;
}

/**
 * The features of a set: `{ kind, specs }`, or undefined when it is not
 * shown. `language` names the thermostat modes.
 */
export function planOf(set, kind, language = 'en') {
  const has = (type) => type in set.features;
  let specs;
  switch (kind) {
    case 'light':
      specs = [powerSpec(C.LIGHT, T.LIGHT.BINARY), brightnessSpec()];
      break;
    case 'switch':
      specs = [powerSpec(C.SWITCH, T.SWITCH.BINARY)];
      break;
    case 'climate':
      specs = [setpointSpec()];
      if (has(F.TEMPERATURE)) specs.unshift(temperatureSpec());
      if (has(F.HEAT_STATE)) specs.push(modeSpec(language));
      if (has(F.VALVE_LEVEL) || has(F.CALL_FOR_HEAT)) specs.push(operatingSpec(set));
      break;
    case 'sensor':
      specs = [];
      break;
    default:
      return undefined;
  }
  specs.push(...extraSpecs(set));
  return specs.length === 0 ? undefined : { kind, specs };
}

export const deviceIds = (gladys, id) => gladys.externalIds('device', id);

/** The Gladys device of a feature set and its plan. */
export function buildDevice(gladys, set, plan, language) {
  const ids = deviceIds(gladys, set.id);
  const params = [
    ['product_code', set.productCode],
    ['structure', set.structureId],
    ['lightwave_kind', plan.kind],
  ]
    .filter(([, v]) => typeof v === 'string' && v !== '')
    .map(([name, v]) => ({ name, value: v.slice(0, 100) }));
  return {
    name: set.name,
    external_id: ids.device,
    should_poll: false,
    params,
    features: plan.specs.map((s) => ({
      name: word(FEATURE_NAMES[s.name], language).slice(0, 100),
      external_id: ids.feature(s.key),
      category: s.category,
      type: s.type,
      ...(s.unit ? { unit: s.unit } : {}),
      min: s.min,
      max: s.max,
      read_only: !s.write,
      has_feedback: true,
      keep_history: true,
      ...(s.supported_options ? { supported_options: s.supported_options } : {}),
    })),
  };
}

/** The current values of a set: `[{ device_feature_external_id, state }]`. */
export function deviceStates(gladys, set, values, plan) {
  const ids = deviceIds(gladys, set.id);
  const states = [];
  for (const s of plan.specs) {
    const v = s.read(values);
    if (typeof v === 'number' && Number.isFinite(v)) {
      states.push({ device_feature_external_id: ids.feature(s.key), state: v });
    }
  }
  return states;
}
