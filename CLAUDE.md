# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15), its only
runtime dependency (HTTPS goes through `node:https`). It uses the **public API
of Lightwave** (`publicapi.lightwaverf.com`) with the API token and the
refresh token of the "API" page of my.lightwaverf.com, reads the hierarchy
once an hour and the feature values every cycle, and shows and commands
lights, sockets, radiator valves, thermostats and sensors. Ported from
lightwave2's `LWLink2Public` (MIT). Never tested with a real account, not
affiliated with Lightwave.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
gi ci                                     # the whole CI locally (Node 24 + 22, Docker, store validator)
```

Run `gi ci` and `audit` before every commit.

## Architecture

```
index.js            SDK bootstrap only
src/handlers.js     every SDK handler -> the app (shared with the tests)
src/app.js          LightwaveApp: cycle and its timer (monotonic), failures, stops and
                    pauses, devices, states, commands (queue, deadlines, holds), badges, button
src/client.js       the account: the bearer token, the refresh token rotation, the API calls
src/http.js         the only network access (node:https, bounded), errors
src/model.js        structure -> feature sets, kinds (pure)
src/devices.js      feature set -> Gladys features, reads, writes of a command (pure)
src/publisher.js    states within 300/min
src/store.js        /data/lightwave-state.json: salt, pause, stop on refused tokens, last attempt
src/config.js       config_schema normalized, the current refresh token, account key
src/constants.js    hosts, paths, feature names, manifest keys, limits, timings
src/i18n.js         runtime texts and feature names (en/fr), command errors
test/fixtures/      structures and values shaped like the public API
test/helpers/       a fake Lightwave behind the transport, a virtual clock; Gladys is the SDK's fake
scripts/cover.mjs   the cover, plain Node
```

## Rules

- **External ids are forever**: device `device:<featureSetId>`, features
  `power`, `brightness`, `temperature`, `setpoint`, `mode`, `heating`,
  `watts`, `battery`, `opening`, `motion`, `humidity`. Never change how they
  are built; the kind of a set comes from its Lightwave features.
- Manifest keys (`api_token`, `refresh_token`, `poll_interval`,
  `allow_heating`, `max_setpoint`, `language`, the action `test_connection`)
  and the internal key `refresh_token_state` are frozen. Never a key prefixed `gladys_`.
- **Public API only**: never the sign-in of the Lightwave app (e-mail,
  password, app identifier header), never a User-Agent of an app.
- **Tokens**: never in `/data`, the logs, a status or an error; the bearer
  token in memory, the refresh token in the Gladys configuration. Never a
  renewal from a command that is not protective, at most one per cycle,
  never after a refusal, never on a 401 of a token issued less than 10 min
  ago.
- **Heating**: the target temperature and mode "heating" behind
  `allow_heating` (off by default), the target bounded to 5 °C and
  `max_setpoint` (40 at most), the option read right before the send; mode
  "off" and 5 °C are protective: not held back by the option, a pause, a
  backoff or the queue, available before the first read after a restart
  (ids in /data), checked by a read and sent again (3 at most). Docs list
  exactly when they can fail; no "always" / "never" claims.
- **Commands**: one at a time per device, refused before they are sent when
  they cannot be answered within Gladys' 5 s, sent once (never retried).
- **Clock**: one read of the monotonic clock per decision (`dueAt(mono)`),
  never a read sooner than the interval (restart, button, reconnection
  included); the wall clock dates `/data` only. Keep the test clock that
  moves at every read and the real-clock test.
- Polling politely: the hierarchy once an hour, the values every 30 to 300 s,
  never sooner after an error; 429 pauses every path but "off". Never add a
  call outside `LightwaveClient`.
- The Discovery list never shrinks; status and Discovery are sent again at
  every `connected`; a reconnection keeps the tokens, the stops and the pauses.
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`;
  `supported_options[].label` is a string; a `secret` field is kept by
  Gladys in its database, in clear: never claim more protection than that.
- Files are UTF-8 without BOM (`test/encoding.test.js`); tests never touch
  the network nor the system temp directory (except the store test's own
  temporary directory).
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` kept in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow (0.1.0 was set by
  hand once, see TODO.md).
