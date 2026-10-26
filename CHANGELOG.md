# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- The Lightwave public API with the API token and the refresh token of the
  "API" page of my.lightwaverf.com (as lightwave2's `LWLink2Public`): the
  bearer token kept in memory and renewed before its end; the new refresh
  token Lightwave gives at each renewal kept in the Gladys configuration by
  the integration itself (never in `/data`, never in the logs).
- The hierarchy (homes and devices) once an hour, the feature values every
  60 s (30 to 300): lights and dimmers (on/off, brightness), sockets and
  relays (on/off), radiator valves and thermostats (temperature, target
  temperature, mode off/heating, heating state), window and movement
  sensors, battery, power in watts. The hub, three-way relays, LEDs and
  buttons are not shown.
- Heating commands off by default (`allow_heating`), target temperature
  bounded to 5 °C and a configurable ceiling (25 °C, 40 at most); mode "off"
  never held back by a pause or the queue.
- Commands serialized per device within Gladys' 5 s and read again after;
  401/403/429/5xx handling with persisted stops and pauses; badges; the
  "Test the connection" button; docs en/fr; cover.

[Unreleased]: https://github.com/LM1LC3N7/gladys-lightwave/commits/main
