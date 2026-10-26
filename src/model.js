// -----------------------------------------------------------------------------
// Lightwave answers -> plain feature sets (pure). A structure of the public
// API holds devices (`productCode`, `featureSets`), each feature set
// (`featureSetId`, `name`, `features` of `featureId` and `type`) being what
// lightwave2 and this integration call a device: a light, a socket, a
// radiator valve… Nothing is guessed: a value out of its range stays unknown.
// -----------------------------------------------------------------------------

import { validId } from './client.js';
import { FEATURES, LIMITS } from './constants.js';

const text = (value) =>
  typeof value === 'string' && value.trim() !== ''
    ? value
        // eslint-disable-next-line no-control-regex -- control characters are what is removed
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, LIMITS.textLength)
    : undefined;

/**
 * The feature sets of a structure answer: `{ id, name, productCode,
 * structureId, features: { <type>: featureId } }`, in the order of the
 * answer. A feature set without a valid id, or a feature without one, is
 * skipped; two feature sets with the same id keep the first one.
 */
export function readStructure(raw, structureId) {
  const sets = [];
  const seen = new Set();
  for (const device of Array.isArray(raw?.devices) ? raw.devices : []) {
    const productCode = text(device?.productCode);
    for (const set of Array.isArray(device?.featureSets) ? device.featureSets : []) {
      const id = validId(set?.featureSetId);
      if (!id || seen.has(id)) {
        continue;
      }
      const features = {};
      for (const feature of Array.isArray(set?.features) ? set.features : []) {
        const featureId = validId(feature?.featureId);
        const type = text(feature?.type);
        if (featureId && type && /^[A-Za-z0-9_]{1,60}$/.test(type) && !(type in features)) {
          features[type] = featureId;
        }
      }
      seen.add(id);
      sets.push({ id, name: text(set?.name) ?? id, productCode, structureId, features });
    }
  }
  return sets;
}

const has = (set, type) => Object.hasOwn(set.features, type);

/**
 * What a feature set becomes in Gladys: `climate` (a radiator valve or a
 * thermostat: a target temperature), `light` (a dim level), `switch` (an
 * on/off that is neither), `sensor` (only readings: window, movement,
 * battery, power, humidity), or undefined when it is not shown (the hub, a
 * three-way relay of blinds, an LED, a button).
 */
export function kindOf(set) {
  if (has(set, FEATURES.TARGET_TEMPERATURE)) {
    return 'climate';
  }
  if (has(set, FEATURES.THREE_WAY_RELAY) || has(set, FEATURES.BUTTON_PRESS)) {
    return undefined;
  }
  if (has(set, FEATURES.SWITCH) && has(set, FEATURES.DIM_LEVEL)) {
    return 'light';
  }
  if (has(set, FEATURES.SWITCH)) {
    return 'switch';
  }
  if (
    [
      FEATURES.WINDOW_POSITION,
      FEATURES.MOVEMENT,
      FEATURES.BATTERY_LEVEL,
      FEATURES.POWER,
      FEATURES.HUMIDITY,
    ].some((type) => has(set, type))
  ) {
    return 'sensor';
  }
  return undefined;
}

/** The feature sets of every structure, by id (the first one wins across structures). */
export function readSets(lists) {
  const sets = new Map();
  for (const list of lists) {
    for (const set of list) {
      if (!sets.has(set.id)) {
        sets.set(set.id, set);
      }
    }
  }
  return sets;
}

/** The ids of every feature the integration reads, across the sets. */
export function featureIdsOf(sets, types) {
  const ids = [];
  for (const set of sets.values()) {
    for (const type of types) {
      const id = set.features[type];
      if (id) {
        ids.push(id);
      }
    }
  }
  return [...new Set(ids)];
}

/**
 * The values of a set: `{ <type>: number }` from the values read (by feature
 * id); a type without a value read is absent.
 */
export function valuesOf(set, values) {
  const out = {};
  for (const [type, id] of Object.entries(set.features)) {
    const value = values.get(id);
    if (value !== undefined) {
      out[type] = value;
    }
  }
  return out;
}
