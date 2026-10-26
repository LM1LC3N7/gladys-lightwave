// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS, LANGUAGES } from '../src/config.js';
import { ACTIONS, POLL_INTERVAL, SETPOINT } from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('the store basics, and the version set by hand to 0.1.0 everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-lightwave:${manifest.version}`);
  assert.equal(manifest.version, JSON.parse(read('package.json')).version);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.deepEqual(manifest.categories, ['lighting', 'climate', 'energy']);
  assert.equal(manifest.keywords, undefined, 'keywords need gladys_version >= 5.3.0');
  assert.equal(manifest.countries, undefined, 'countries need gladys_version >= 5.3.0');
  assert.match(manifest.gladys_version, /^>=5\.1\.0$/);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not[\s>]+affiliated[\s>]+with|sans[\s>]+lien[\s>]+avec/i);
    assert.match(
      docs,
      /never[\s>]+tested[\s>]+with[\s>]+a[\s>]+real|jamais[\s>]+testée[\s>]+avec[\s>]+un[\s>]+vrai/i,
    );
    assert.doesNotMatch(docs, /chiffr|encrypt/i, 'a secret field is not encrypted by Gladys');
  }
  for (const file of ['README.md', 'TODO.md', 'CLAUDE.md', 'CHANGELOG.md']) {
    assert.doesNotMatch(read(file), /\b(chiffré|encrypted)\b/i, `${file}: never "encrypted"`);
  }
});

test('no false absolute about the protective commands (review r1, point 9)', () => {
  const FALSE =
    /always accepted|toujours accepté|never held back|n'est refusé que|is refused only|passe quand même|still goes through|is used once|ne sert qu'une fois[^,]/i;
  for (const file of [
    'gladys-assistant-integration.json',
    'docs/en.md',
    'docs/fr.md',
    'README.md',
    'CLAUDE.md',
    'CHANGELOG.md',
  ]) {
    assert.doesNotMatch(read(file), FALSE, file);
  }
  for (const lang of ['en', 'fr']) {
    assert.match(read(`docs/${lang}.md`), /no identifier kept|aucun identifiant\s+gardé/);
  }
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
});

test('the configuration matches the code', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const key of Object.keys(fields)) {
    assert.doesNotMatch(key, /^gladys_/i, 'a key prefixed gladys_ is never received');
  }
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    LANGUAGES,
  );
  for (const key of ['api_token', 'refresh_token']) {
    assert.equal(fields[key].type, 'secret', `${key} is never sent back to the browser`);
    assert.equal(fields[key].required, true);
    assert.equal('default' in fields[key], false, 'no default on a secret field');
    for (const lang of ['en', 'fr']) {
      assert.doesNotMatch(fields[key].description[lang], /chiffr|encrypt/i);
    }
  }
  assert.deepEqual(
    [fields.poll_interval.min, fields.poll_interval.max],
    [POLL_INTERVAL.min, POLL_INTERVAL.max],
  );
  assert.equal(fields.allow_heating.type, 'boolean');
  assert.equal(fields.allow_heating.default, false, 'the heating commands are off by default');
  assert.deepEqual(
    [fields.max_setpoint.min, fields.max_setpoint.max],
    [SETPOINT.min, SETPOINT.max],
  );
  assert.ok(SETPOINT.max <= 40, "never above Lightwave's own limit");
  const intro = fields.intro;
  assert.equal(intro.type, 'section');
  for (const lang of ['en', 'fr']) {
    assert.ok(intro.description[lang].length <= 1000, `intro.${lang} over 1000 characters`);
    assert.match(intro.description[lang], /Lightwave/);
  }
  assert.ok(intro.links.length <= 5 && intro.links.every((l) => l.url.startsWith('https://')));
});

test('the actions are those of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  for (const action of manifest.actions) {
    assert.ok(action.timeout_seconds >= 5 && action.timeout_seconds <= 120);
  }
});

test('the image ships the licenses, and the license names nobody', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.doesNotMatch(license, /Copyright \d{4} [A-Z]/, 'the standard text, no name');
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /Copyright \(c\) 2018 Bryan Robert Blunt/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
  assert.doesNotMatch(
    read('src/constants.js'),
    /autouserlogin|lwapps|x-lwrf-appid/,
    'never the app sign-in',
  );
  assert.doesNotMatch(
    read('src/client.js'),
    /autouserlogin|lwapps|x-lwrf-appid/,
    'never the app sign-in',
  );
});
