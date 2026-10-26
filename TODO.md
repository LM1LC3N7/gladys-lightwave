# TODO — Lightwave Smart v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests on Node 24 and 22,
  Docker build, store validator), `npm run audit`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session: the batch
  reserved in /t/10385 gets one recap message there per wave.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-25): the public API of Lightwave
      (token endpoint, structures, feature values, feature writes) ported
      from lightwave2's `LWLink2Public`; the rotated refresh token kept in the
      Gladys configuration; lights, sockets, radiator valves, thermostats,
      window and movement sensors, battery, power; heating commands behind
      `allow_heating` with a bounded target, protective "off" / 5 °C; commands
      serialized per device within Gladys' 5 s; 401/403/429/5xx with
      persisted stops and pauses; monotonic pacing with a real-clock test;
      badges; docs en/fr; cover. Tested against made-up answers only (Node 24
      and 22). Not tried on a real account.
- [x] **Milestone 1 fixes — review r1** (2026-10-26): protective "off" and
      5 °C before the first read after a restart (ids in /data), through
      pauses, renewing a missing token, sent again on a 401; commands
      checked by a read (protective ones sent again, 3 at most; others
      warned about after 15 s); a heating command in flight overtaken by an
      "off" (sticky resend, queued ones cancelled); a 401 on a fresh token
      no longer renews (api_refused, stop at the 3rd); token endpoint
      refusal only on OAuth answers; bounds (500 sets, 10 batches); stale
      values not republished; getConfig fallback; grouped rereads; batch
      isolation; monotonic publisher window; safer ids; one internal key with
      a hashed seed; docs without false absolutes.
- [ ] **Milestone 2 — real account**: run against a real account (see "To
      check on a real account"), turn the answers (anonymized) into fixtures,
      fix what differs.
- [ ] **Milestone 3 — more devices**: three-way relays as Gladys shutters
      (`threeWayRelay` 1 open, 2 close, 0 stop; opening behind an option, close
      and stop always, no position feedback), the valve level presets of the
      TRVs (`valveLevel` 20/40/60/80/100 %), the button lock (`protection`,
      child-lock), the LED colours (`rgbColor`), the physical button events
      (`uiButton`, `uiButtonPair`) as scene triggers, the illuminance
      (`lightLevel`, unit to confirm) and the signal strength (`rssi`).
- [ ] **Milestone 4 — energy index**: the cumulative `energy` (Wh) of the
      sockets and dimmers as an `energy-sensor/index` with the guard of
      gladys-p1-monitor (`src/guard.js` taken as is: never 0, jumps and drops
      held until the user accepts them, one button per meter).
- [ ] **Milestone 5 — live updates**: the webhooks of the public API
      (`POST /v1/events`) through the Gladys Plus incoming webhooks of the
      SDK, with the polling as a true-up, if a public URL is available.
- [ ] **Migration**: SDK 0.16.0 when it is on npm (types ai/tts/music, nothing
      breaking); then `keywords` (`lightwave`, `lightwaverf`, `link plus`,
      `smart series`, `trv`, `dimmer`, `uk`) and `countries` (`GB`, `IE`) with
      `gladys_version: ">=5.3.0"`, and `poll_frequency` if the sibling modules
      take it.

## Decisions

- **Version 0.1.0 set by hand** (package.json, package-lock.json, manifest,
  `docker_image` tag) at milestone 1; the first release patch gives 0.1.1.
  Versions then belong to the Release workflow.
- **SDK `^0.15.0`**, not the `^0.16.0` of the template: 0.16.0 was tagged but
  not on npm on 2026-10-25. Migration planned (see above).
- **No `keywords` nor `countries`** in the manifest yet: they need
  `gladys_version >= 5.3.0`, released on 2026-10-25, which would block the
  installation on any instance not yet updated.
- **Public API only**: the token endpoint and `publicapi.lightwaverf.com`.
  The sign-in path of the Lightwave app with an e-mail and a password (an
  app identifier header) that lightwave2 also carries is never used: no
  imitation of an application.
- **The rotated refresh token lives in the Gladys configuration**
  (`setConfig`, one key outside the schema, `refresh_token_state`, so the
  token and its seed are always written together; the seed is a hash of the
  pasted token, never a second copy of it), not in `/data`: the brief forbids
  a secret in `/data`, and the SDK documents `setConfig` as the place for
  tokens. `src/config.js` chooses between the pasted token and the rotated
  one by comparing the hash of the pasted field with the seed.
  Assumed: a used refresh token is spent (lightwave2 stores the new one);
  to confirm on a real account. If Lightwave does not rotate, nothing
  changes (the pasted token is reused).
- **A refused token is final**: no spaced new tries (a spent refresh token
  stays spent; new tries could lock the account); new tokens pasted lift
  the stop. "Refused" only on an OAuth answer (400/401 with
  `invalid_grant`, `invalid_client`, `unauthorized_client`, or a 401 in
  JSON); any other answer (403, a proxy page) waits for a click, the tokens
  being probably unspent (review r1).
- **A 401 on a bearer token issued less than 10 min ago** is not renewed
  again (it would spend a refresh token per cycle): 2 then 4 min, then a
  stop persisted at the 3rd, lifted by a click or new tokens (review r1).
- **Heating**: `allow_heating` off by default, `max_setpoint` 25 °C by
  default and 40 °C at most (the range of the Home Assistant integration);
  a target out of bounds is refused with its exact reason, never clamped.
  Mode "off" (`heatState` 0) and 5 °C (`targetTemperature` 50, the only
  way to stop a radiator valve, which has no off) are the protective
  commands: they bypass the option, the pauses, the backoff and the queue;
  the feature ids of the heating sets are kept in /data (not secret) so they
  work after a restart before the first read; they renew a missing bearer
  token and send again once on a 401; a read contradicting them sends them
  again (3 at most) with a warning; a heating command still queued is
  cancelled, one in flight makes the "off" leave again after its answer
  (review r1).
- **Commands confirmed by a read**, not by the HTTP 200: a target or a mode
  a read contradicts after 15 s is a warning in the status, not resent.
- **Freshness**: a value older than max(2 × interval, 10 min) is never
  published again (update of a device, reconnection to Gladys).
- **Bounds**: 2000 sets per structure, 500 shown, 10 `features/read` per
  cycle; only the features of the shown sets are read.
- **Thermostat mode only with `heatState`**: a radiator valve has no
  off/heat switch in Lightwave (its target temperature is the only command).
- **Energy**: power in W only in v1; the cumulative Wh needs the index guard
  (milestone 4). No `energy-sensor/energy` without it.
- **Three-way relays hidden** in v1: the same relay drives blinds or garage
  doors; opening will go behind an option, close and stop always (milestone
  3).
- **Hierarchy hourly, values every cycle**: one request per structure per
  hour plus one `features/read` per 150 features per cycle; a structure not
  read is tried again in 5 minutes.
- **Window sensor**: Lightwave `windowPosition` 1 taken as open (the Home
  Assistant window binary sensor), mapped to Gladys' opening sensor 0 = open.
  To confirm on a real sensor.
- **Temperatures in tenths of a degree** (lightwave2 `int(level * 10)`): to
  confirm on a real device, including for gen 1 thermostats.

## To check on a real account

- The token endpoint: the exact `expires_in`, whether the refresh token is
  single-use and rotated at every call, the answer when it is reused (400
  `invalid_grant` assumed), whether the API token alone is refused with a 401.
- The structure answer: the fields of `featureSets` and `features`
  (`featureSetId`, `name`, `featureId`, `type`; `writable`/`readable` flags
  if any), the product codes, whether a structure may hold hundreds of
  features (the 2 MiB bound).
- `features/read`: the shape `{ <featureId>: value }` (lightwave2 reads it
  so), the limit of 150 per request, the rate limit (429 with or without
  `Retry-After`).
- The writes: whether `POST /feature/<id>` answers `{ value }`, whether a
  `dimLevel` write turns a light on by itself (then the second write is
  needless), whether `+` in a feature id is accepted as is in the path.
- The scales: `temperature`/`targetTemperature` ×10 on every device,
  `power` in W, `batteryLevel` in %, `windowPosition` 1 = open,
  `valveLevel` and `callForHeat` on real valves and thermostats.
