// -----------------------------------------------------------------------------
// The reading of a structure answer and the kinds of the feature sets (pure).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validId } from '../src/client.js';
import { featureIdsOf, kindOf, readSets, readStructure, valuesOf } from '../src/model.js';
import { FEATURE_IDS, SETS, STRUCTURES, homeStructure } from './fixtures/lightwave.js';

test('a structure: one feature set per entry, features by type, texts bounded', () => {
  const sets = readStructure(homeStructure(), STRUCTURES.home);
  assert.equal(sets.length, 7);
  const light = sets.find((s) => s.id === SETS.light);
  assert.equal(light.name, 'Garden Room');
  assert.equal(light.productCode, 'L22');
  assert.equal(light.structureId, STRUCTURES.home);
  assert.deepEqual(light.features, FEATURE_IDS[SETS.light]);
});

test('a hostile structure: bad ids, control characters, duplicates, long names', () => {
  const raw = {
    devices: [
      {
        productCode: 'X\u0000Y',
        featureSets: [
          { featureSetId: 'a/b', name: 'skipped', features: [] },
          {
            featureSetId: 'ok-1',
            name: `\u0007${'n'.repeat(200)}`,
            features: [
              { featureId: 'f1', type: 'switch' },
              { featureId: 'f2', type: 'switch' },
              { featureId: 'bad id', type: 'dimLevel' },
              { featureId: 'f3', type: 'a type' },
              { featureId: 'f4', type: 'x'.repeat(61) },
            ],
          },
          { featureSetId: 'ok-1', name: 'duplicate', features: [] },
          { featureSetId: 'ok-2', features: 'not a list' },
        ],
      },
      null,
      { featureSets: null },
    ],
  };
  const sets = readStructure(raw, 's');
  assert.deepEqual(
    sets.map((s) => s.id),
    ['ok-1', 'ok-2'],
  );
  assert.equal(sets[0].name.length, 100);
  assert.equal(sets[0].productCode, 'X Y');
  assert.deepEqual(sets[0].features, { switch: 'f1' }, 'the first id of a type, valid ids only');
  assert.equal(sets[1].name, 'ok-2', 'the id when the name is missing');
  assert.deepEqual(readStructure(null, 's'), []);
  assert.equal(validId('x'.repeat(121)), undefined);
  assert.equal(validId('5bc4d06e-28-3157334318+1'), '5bc4d06e-28-3157334318+1');
});

test('the kinds: climate, light, switch, sensor; the hub and a three-way relay hidden', () => {
  const sets = readStructure(homeStructure(), STRUCTURES.home);
  const kind = (id) => kindOf(sets.find((s) => s.id === id));
  assert.equal(kind(SETS.light), 'light');
  assert.equal(kind(SETS.socket), 'switch');
  assert.equal(kind(SETS.trv), 'climate');
  assert.equal(kind(SETS.boiler), 'climate');
  assert.equal(kind(SETS.window), 'sensor');
  assert.equal(kind(SETS.hub), undefined);
  assert.equal(kind(SETS.blind), undefined);
  assert.equal(kindOf({ features: { identify: 'x' } }), undefined, 'nothing to read');
  assert.equal(kindOf({ features: { switch: 'a', threeWayRelay: 'b' } }), undefined);
});

test('the sets of several structures, the feature ids read, the values of a set', () => {
  const sets = readSets([
    readStructure(homeStructure(), STRUCTURES.home),
    readStructure(homeStructure(), 'again'),
  ]);
  assert.equal(sets.size, 7, 'the first one wins');
  assert.equal(sets.get(SETS.light).structureId, STRUCTURES.home);
  const ids = featureIdsOf(sets, ['switch', 'dimLevel']);
  assert.deepEqual(ids, [
    FEATURE_IDS[SETS.light].switch,
    FEATURE_IDS[SETS.light].dimLevel,
    FEATURE_IDS[SETS.socket].switch,
  ]);
  const values = new Map([
    [FEATURE_IDS[SETS.light].switch, 1],
    [FEATURE_IDS[SETS.light].dimLevel, 42],
  ]);
  assert.deepEqual(valuesOf(sets.get(SETS.light), values), { switch: 1, dimLevel: 42 });
  assert.deepEqual(valuesOf(sets.get(SETS.socket), values), {});
});
