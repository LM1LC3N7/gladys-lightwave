import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountKey,
  currentRefreshToken,
  normalizeConfig,
  readTokenState,
  seedHash,
  tokenState,
} from '../src/config.js';

test('the configuration normalized: trimmed tokens, bounded numbers, flags, known language', () => {
  const config = normalizeConfig({
    api_token: ' abc ',
    refresh_token: ' r1 ',
    poll_interval: '45',
    allow_heating: 'true',
    max_setpoint: '21.6',
    language: 'EN',
  });
  assert.equal(config.apiToken, 'abc');
  assert.equal(config.refreshToken, 'r1');
  assert.equal(config.pastedRefreshToken, 'r1');
  assert.equal(config.account, accountKey('abc'));
  assert.equal(config.pollInterval, 45);
  assert.equal(config.allowHeating, true);
  assert.equal(config.maxSetpoint, 22);
  assert.equal(config.language, 'en');
  const defaults = normalizeConfig();
  assert.deepEqual(
    [
      defaults.pollInterval,
      defaults.allowHeating,
      defaults.maxSetpoint,
      defaults.language,
      defaults.account,
    ],
    [60, false, 25, 'fr', ''],
  );
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
  assert.equal(normalizeConfig({ poll_interval: 600 }).pollInterval, 300);
  assert.equal(normalizeConfig({ poll_interval: 'x' }).pollInterval, 60);
  assert.equal(normalizeConfig({ max_setpoint: 99 }).maxSetpoint, 40);
  assert.equal(normalizeConfig({ max_setpoint: 1 }).maxSetpoint, 5);
  assert.equal(normalizeConfig({ allow_heating: 'yes' }).allowHeating, false, 'unknown: off');
  assert.equal(normalizeConfig({ allow_heating: 1 }).allowHeating, true);
  assert.equal(normalizeConfig({ language: 'de' }).language, 'fr');
});

test('the refresh token in use: the rotated one while the pasted one is its seed (hashed)', () => {
  const state = (seed, current) => ({ refresh_token_state: tokenState(seedHash(seed), current) });
  assert.equal(currentRefreshToken({ refresh_token: 'p1' }), 'p1');
  assert.equal(currentRefreshToken({ refresh_token: 'p1', ...state('p1', 'r9') }), 'r9');
  assert.equal(
    currentRefreshToken({ refresh_token: 'p2', ...state('p1', 'r9') }),
    'p2',
    'a new one pasted',
  );
  assert.equal(
    currentRefreshToken({ refresh_token: 'p1', refresh_token_state: '{bad json' }),
    'p1',
  );
  assert.equal(currentRefreshToken({ ...state('p1', 'r9') }), '', 'nothing pasted');
  assert.ok(!tokenState(seedHash('p1'), 'r9').includes('p1'), 'the pasted token is never kept');
  assert.equal(readTokenState({ seed: 'short', current: 'x' }), undefined);
  assert.deepEqual(readTokenState(tokenState(seedHash('a'), ' r ')), {
    seed: seedHash('a'),
    current: 'r',
  });
});
