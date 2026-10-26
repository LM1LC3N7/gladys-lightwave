# Lightwave Smart for Gladys Assistant

Shows and commands in Gladys the **Lightwave Smart** devices of your Lightwave
account (United Kingdom; Link Plus hub, generation 1 "Connect" and generation 2
"Smart" devices), through the **public API of Lightwave**.

> **Never tested with a real account.** The integration talks to the public
> API that Lightwave opens to every account (`publicapi.lightwaverf.com`),
> written from the lightwave2 library and its Home Assistant integration, and
> tested with made-up answers only. Lightwave may change the API. Not
> affiliated with Lightwave.

## What you get

One Gladys device per Lightwave "feature set" (a light, a socket, a radiator
valve…):

| Lightwave device                                  | Gladys features                                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Light, dimmer (a `dimLevel`)                      | On/Off (`light/binary`), Brightness (0 to 100), Power in W when the device reports it  |
| Socket, relay, switch (a `switch` without level)  | On/Off (`switch/binary`), Power in W when reported                                     |
| Radiator valve (TRV)                              | Temperature (°C), Target temperature (°C), Heating now (1 = valve open), Battery (%)   |
| Thermostat, boiler or heating relay (`heatState`) | Temperature, Target temperature, Mode (off / heating), Heating now (1 = call for heat) |
| Window or door sensor                             | Window (0 = open, 1 = closed, Gladys' opening sensor), Battery                         |
| Movement sensor                                   | Movement (1 = yes), Battery                                                            |

- **Brightness**: 0 turns the light off; any other value sets the level then
  turns the light on (two requests, as the Lightwave app does).
- **Target temperature** and **Mode "heating"**: refused until you turn on
  _Allow the heating commands_ in the configuration. A target is also refused
  below 5 °C or above the _Highest target temperature_ of the configuration
  (25 °C by default, 40 °C at most: Lightwave's own limit). **Mode "off"** is
  accepted whatever the option and whatever pause is running, as long as the
  integration holds a bearer token; it is refused only when the tokens were
  refused by Lightwave (no token to send it with) or when the device is no
  longer in the last hierarchy read (run a Scan).
- **Heating now** (read only): the valve open (`valveLevel` above 0), or the
  call for heat of a thermostat.
- **Not shown in this version**: the Link Plus hub, three-way relays (blinds,
  garage doors), the LED colours, the physical button events, the button
  lock (`protection`), the cumulative energy (Wh) of the sockets, the signal
  strength, the illuminance of the sensors.

Lights (`light/binary`) and sockets or relays (`switch/binary`) are ordinary
Gladys commands: an "everything off" of Gladys, of a voice assistant or of a
scene turns them off too. Do not wire a relay to something that must never be
cut from Gladys (a freezer, a gate motor): leave it out of Gladys.

## Setup

1. Sign in to [my.lightwaverf.com](https://my.lightwaverf.com), open the
   **API** page of your account and create an **API token** and a **refresh
   token** (Lightwave calls them "basic" token and "refresh" token).
2. In Gladys, install the **Lightwave Smart** integration from the store, paste
   the two tokens, save.
3. Open the **Discovery** tab and add the devices.

The two fields are `secret` fields: Gladys keeps them in its database (in
clear, as any configuration value, and in its backups), never shows them
again, and the integration sends them only to Lightwave
(`auth.lightwaverf.com`). The API token identifies your account; the refresh
token is exchanged for a **bearer token** that lives a day (Lightwave says how
long) and is kept in memory only.

### The refresh token is used once

Lightwave gives a **new refresh token** with every bearer token, and the one
you pasted is spent at the first use. The integration keeps the new one in the
Gladys configuration by itself (two hidden values beside the field: the token
Lightwave gave last, and the one you pasted it derives from), so a restart or
a renewal uses the right one without you doing anything. The pasted field
stays as you left it; paste a new refresh token only when the status asks for
it.

If Gladys could not save the new token (Gladys unreachable at that moment),
the status says so: the token is kept in memory and saved again at the next
read. Do not restart the integration before the status is back to normal, or
the new token is lost and the status asks for another one.

## Refresh

The feature values are read every **60 seconds** by default (30 to 300,
_Refresh interval_), one request per 150 features; the hierarchy (the homes
of the account and their devices) is read **once an hour**, one request per
home plus one for the list. A home that fails to be read keeps its last
devices, marked "unreachable", with their last values not sent again; it is
tried again 5 minutes later, without stopping the reads of the other homes.

A command leaves at once; the value sent is shown at once, the device is read
again 2 seconds later, and a slightly late read does not undo the commanded
value (15 seconds). The commands of one device go one after the other. Gladys
waits 5 seconds for the answer: a command that has not left 3 seconds after
the click (queue, token renewal in progress, slow network) is refused
**without having been sent**; a command sent but slow is answered at 4.3
seconds and its effect shows afterwards.

The _Test the connection_ button renews the bearer token if needed and reads
the devices once, but never sooner than the interval after the last read (it
then tells when the next read comes), and at most once every 30 seconds.

## Troubleshooting

- **API token or refresh token refused** (HTTP 400, 401 or 403 of the token
  endpoint): the integration stops, even after a restart, and never tries
  again by itself (a spent refresh token stays spent, and new tries could
  lock the account). Generate a new refresh token on the API page, paste it,
  save: one new try at once.
- **Token request rejected** (any other status): the integration stops until
  you click _Test the connection_ or save the configuration.
- **Bearer token refused by the API** (HTTP 401 of a read): one renewal and
  the read again; refused again right after, the cycle is counted as
  unreachable and the next cycle renews again. A 401 on a command never
  renews from the command: the command fails, the next cycle renews.
- **Too many requests (HTTP 429)**: a pause of 1 minute to 6 hours
  (Lightwave's `Retry-After`, 15 minutes without it) for the reads, the
  commands and the button, kept after a restart or a reconnection to Gladys.
  Mode "off" of a thermostat still goes through, once.
- **HTTP 403 of the reads**: a one-hour pause of every path (except mode
  "off"). A 403 of a command is that command refused, nothing else.
- **Lightwave unavailable (5xx, network, bad answer)**: new tries after 1, 2,
  5, 10, then every 15 minutes, never sooner than the interval.

## Limits

- Public API: Lightwave may change it or limit its use.
- No live updates (the webhooks of the public API need a public URL): one
  read every 30 to 300 seconds. Gen 1 devices do not report their state by
  themselves: a change made on the wall switch may take a cycle to show.
- One Lightwave account per Gladys, ten homes at most.
- No three-way relays, LED colours, button events, energy index nor settings
  in this version.
- Never tested with a real account: please report what you see on the
  [GitHub repository](https://github.com/LM1LC3N7/gladys-lightwave/issues)
  (without your tokens).

## Privacy

The integration keeps in `/data/lightwave-state.json` (readable by its own
container only): a random salt, the end of a pause, the time of the last read
attempt, and a stop on refused tokens tied to a salted fingerprint of the two
tokens. Never a token: the bearer token lives in memory, the refresh tokens
in the Gladys configuration. The device and feature ids of Lightwave are the
identifiers of the Gladys devices. Nothing is sent anywhere but to Lightwave.
