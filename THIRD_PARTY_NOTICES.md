# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the projects below, distributed under
the MIT License, whose notices are reproduced in full as that license asks.

## lightwave2

<https://github.com/AbsenteeAtom/lightwave2>, by Bryan Robert Blunt, the
Python library of the Lightwave Smart custom integration of Home Assistant.
MIT License (`LICENSE` of the repository, default branch read on 2026-10-25).

Ported in `src/constants.js` and `src/client.js`, from its `LWLink2Public`
class only (the public API): the token endpoint
(`POST https://auth.lightwaverf.com/token` with the API token as the `basic`
authorization and `{ grant_type: "refresh_token", refresh_token }`, the
`access_token`, `refresh_token` and `expires_in` of the answer), the API root
(`https://publicapi.lightwaverf.com/v1/`), the structures of the account
(`structures`, `structure/<id>` with its devices, their `productCode` and
`featureSets` of `featureSetId`, `name` and `features` of `featureId` and
`type`), the read of feature values (`POST features/read` with
`{ features: [{ featureId }] }`, 150 per request), the read and write of one
feature (`feature/<id>`, `{ value }`). Ported in `src/model.js` and
`src/devices.js`: the kinds of feature sets (`is_light`, `is_switch`,
`is_climate`, `is_trv`, `is_cover`, `is_hub`, `is_windowsensor`,
`is_motionsensor`), the write of the brightness (`dimLevel` then `switch`),
and the scale of the target temperature (`int(level * 10)`). Not taken: the
sign-in of the app (`autouserlogin/lwapps`, `x-lwrf-appid`), the websocket
of the app, the webhooks (`events`), the retry on 429 (replaced by a bounded
pause), the LED colours, the three-way relays, the valve level presets.

```
MIT License

Copyright (c) 2018 Bryan Robert Blunt

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## homeassistant-lightwave2

<https://github.com/bigbadblunt/homeassistant-lightwave2>, by Bryan Robert
Blunt, the Lightwave Smart custom integration of Home Assistant (same
author, same MIT License, same notice as above; default branch read on
2026-10-25). Read for the meaning of the features, ported in
`src/devices.js`: `temperature` and `targetTemperature` in tenths of a degree
Celsius, `heatState` 0/1 as the off/heat mode, `valveLevel` and `callForHeat`
as the heating state, `windowPosition` and `movement` as binary sensors,
`batteryLevel` in percent, `power` in watts, 0 to 40 °C as the range of a
target temperature. No code taken beyond these facts.

## Also read, nothing taken

- [gladys-leviton](https://github.com/LM1LC3N7/gladys-leviton) and
  [gladys-iskra](https://github.com/LM1LC3N7/gladys-iskra) (Apache-2.0, same
  author as this integration): the structure of the module, the transport,
  the publisher, the store and the clock model are theirs.
