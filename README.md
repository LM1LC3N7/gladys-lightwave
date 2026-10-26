# gladys-lightwave

[Gladys Assistant](https://gladysassistant.com) external integration for
**Lightwave Smart** (UK; Link Plus hub, generation 1 and 2 devices) through
the **public API of Lightwave**: lights and dimmers, sockets and relays,
radiator valves and thermostats (heating commands behind an option), window
and movement sensors, battery, power. **Never tested with a real account. Not
affiliated with Lightwave.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (LightwaveApp)
                                  ├─ src/client.js     the bearer token, the public API calls
                                  ├─ src/http.js       the only HTTPS access, errors, bounds
                                  ├─ src/model.js      structure -> feature sets, kinds (pure)
                                  ├─ src/devices.js    feature set -> Gladys features, commands (pure)
                                  ├─ src/publisher.js  states within 300/min
                                  └─ src/store.js      /data/lightwave-state.json (no token)
```

- **Tokens** (as lightwave2's `LWLink2Public`): `POST https://auth.lightwaverf.com/token`
  with the API token as the `basic` authorization and
  `{ "grant_type": "refresh_token", "refresh_token": … }`; the answer gives
  the bearer token (`expires_in`, one hour assumed without it) **and a new
  refresh token**. The bearer token lives in memory, renewed a tenth of its
  life before its end (5 min to 1 h), or once after a 401 of a read. The new
  refresh token is kept in the Gladys configuration through `setConfig`, as
  two keys outside the schema (`refresh_token_current`, and
  `refresh_token_seed`: the pasted token it derives from); `src/config.js`
  picks the current one while the pasted field still equals the seed, the
  pasted one otherwise. Not saved (Gladys unreachable): kept in memory,
  saved again at every cycle, said in the status. Never a token in `/data`
  nor in the logs.
- **Reads**: `GET /v1/structures`, then `GET /v1/structure/<id>` for each
  (ten at most), once an hour, each structure on its own (a failure keeps its
  last feature sets, unreachable and not sent again, tried again in 5 min);
  `POST /v1/features/read` with the ids of the features read (150 per
  request) every 60 s (30–300). Answers read up to 2 MiB, redirects never
  followed, a new socket per request, ids of a safe alphabet only.
- **Commands**: `POST /v1/feature/<id>` with `{ "value": n }`: `switch` 0/1,
  `dimLevel` then `switch` 1 for a brightness (0: `switch` 0),
  `targetTemperature` in tenths of a degree, `heatState` 0/1. One at a time
  per device, sent within 3 s of the click (queue, renewal in progress and a
  send limit included) or refused unsent, "done" at 4.3 s only once sent,
  never a renewal from a command; the value shown at once and held 15 s
  against a stale read, the set read again 2 s after.
- **Heating safety**: the target temperature and the mode "heating" are
  refused unless `allow_heating` (off by default), read from the
  configuration right before the send; a target is bounded to 5 °C and
  `max_setpoint` (25 by default, 40 at most). Mode "off" is protective:
  never held back by a 429/403 pause, a backoff or the queue of the device;
  it needs a bearer token.
- **Errors**: a refused refresh or API token (400/401/403 of the token
  endpoint): a final stop kept in `/data` (salted fingerprint of the tokens),
  lifted by new tokens only; any other refusal of the token endpoint: a stop
  until a click. 429 (`Retry-After` bounded to 1 min – 6 h, 15 min without
  it) and a 403 of the reads (1 h) pause every path but "off", kept in
  `/data` and capped when read back. 5xx/network/bad answers: 1, 2, 5, 10,
  then 15 minutes, never under the interval. A 401 of a read: one renewal
  and the read again; every read failing after it counts as unreachable.
- **Clock**: the reads, pauses, holds and command deadlines are paced on the
  monotonic clock (`dueAt(mono)` takes the instant already read: one read of
  the clock per decision); the wall clock dates `/data` only. A restart
  never reads sooner than the interval after the last attempt.
- **Gladys side**: one device per feature set (`device:<featureSetId>`),
  features by role (`power`, `brightness`, `temperature`, `setpoint`, `mode`,
  `heating`, `watts`, `battery`, `opening`, `motion`, `humidity`); the hub,
  three-way relays, LEDs and buttons are hidden. The Discovery list never
  shrinks; created features are kept as Gladys has them; status, Discovery,
  badges and states are sent again at every reconnection to Gladys.

## Credits

The token endpoint, the paths and the feature names are ported from
[lightwave2](https://github.com/AbsenteeAtom/lightwave2) (Bryan Robert Blunt,
MIT), the library of the Lightwave Smart custom integration of Home
Assistant; the meaning and scale of the features from
[homeassistant-lightwave2](https://github.com/bigbadblunt/homeassistant-lightwave2)
(same author, MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The
sign-in of the Lightwave app (e-mail and password) is never used. Modelled on
the sibling integrations [gladys-leviton](https://github.com/LM1LC3N7/gladys-leviton)
(cloud account, commands) and [gladys-iskra](https://github.com/LM1LC3N7/gladys-iskra)
(monotonic clock, real-clock test).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
node scripts/cover.mjs cover.png                # the cover (800x534)
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never touch the network: Lightwave is a fake behind the injected
transport, Gladys is the SDK's fake, the clock is virtual (its monotonic
reading moves at every call); `test/http.test.js` and
`test/realclock.test.js` run the real transport and the real clock against a
loopback server.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from MIT projects, credited
with their notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also
shipped in the Docker image).
