// -----------------------------------------------------------------------------
// Made-up answers of the Lightwave public API, shaped like what lightwave2's
// LWLink2Public reads (`structures`, `structure/<id>` with devices and their
// feature sets, `features/read`). Ids look like Lightwave's
// (`<structure>-<n>-<serial>+<channel>`), the values like the Home Assistant
// integration expects them (tenths of a degree, 0-100 levels, 0/1 flags).
// -----------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const NOW = Date.UTC(2026, 9, 25, 10, 0, 0);

export const API_TOKEN = 'YXBpLXRva2VuLWJhc2ljLXNlY3JldA==';
export const REFRESH_TOKEN = 'refresh-token-pasted-0001';

export const STRUCTURES = { home: '5bc4d06e87779374d29d7d9a', cabin: '6cd5e17f98880485e3a8e0ab' };

/** The feature set ids (one Gladys device each). */
export const SETS = {
  light: `${STRUCTURES.home}-5bc4d61387779374d29fdd1e`,
  socket: `${STRUCTURES.home}-5bc4d61387779374d29fdd2f`,
  trv: `${STRUCTURES.home}-5bc4d61387779374d29fdd3a`,
  boiler: `${STRUCTURES.home}-5bc4d61387779374d29fdd4b`,
  window: `${STRUCTURES.home}-5bc4d61387779374d29fdd5c`,
  hub: `${STRUCTURES.home}-5bc4d61387779374d29fdd6d`,
  blind: `${STRUCTURES.home}-5bc4d61387779374d29fdd7e`,
  cabinLight: `${STRUCTURES.cabin}-6cd5e17f98880485e3a8e0ff`,
};

/** The feature ids, by set and type. */
export const FEATURE_IDS = {
  [SETS.light]: {
    switch: `${STRUCTURES.home}-28-3157334318+1`,
    dimLevel: `${STRUCTURES.home}-30-3157334318+1`,
    protection: `${STRUCTURES.home}-29-3157334318+1`,
    power: `${STRUCTURES.home}-31-3157334318+1`,
    energy: `${STRUCTURES.home}-32-3157334318+1`,
  },
  [SETS.socket]: {
    switch: `${STRUCTURES.home}-40-3157334319+1`,
    power: `${STRUCTURES.home}-41-3157334319+1`,
    outletInUse: `${STRUCTURES.home}-42-3157334319+1`,
  },
  [SETS.trv]: {
    temperature: `${STRUCTURES.home}-50-3157334320+1`,
    targetTemperature: `${STRUCTURES.home}-51-3157334320+1`,
    valveLevel: `${STRUCTURES.home}-52-3157334320+1`,
    valveSetup: `${STRUCTURES.home}-53-3157334320+1`,
    batteryLevel: `${STRUCTURES.home}-54-3157334320+1`,
    rssi: `${STRUCTURES.home}-55-3157334320+1`,
  },
  [SETS.boiler]: {
    temperature: `${STRUCTURES.home}-60-3157334321+1`,
    targetTemperature: `${STRUCTURES.home}-61-3157334321+1`,
    heatState: `${STRUCTURES.home}-62-3157334321+1`,
    callForHeat: `${STRUCTURES.home}-63-3157334321+1`,
  },
  [SETS.window]: {
    windowPosition: `${STRUCTURES.home}-70-3157334322+1`,
    batteryLevel: `${STRUCTURES.home}-71-3157334322+1`,
  },
  [SETS.hub]: {
    buttonPress: `${STRUCTURES.home}-80-3157334323+1`,
    rgbColor: `${STRUCTURES.home}-81-3157334323+1`,
  },
  [SETS.blind]: {
    threeWayRelay: `${STRUCTURES.home}-90-3157334324+1`,
  },
  [SETS.cabinLight]: {
    switch: `${STRUCTURES.cabin}-28-4157334318+1`,
    dimLevel: `${STRUCTURES.cabin}-30-4157334318+1`,
  },
};

const featureSet = (id, name, features) => ({
  featureSetId: id,
  name,
  features: Object.entries(features).map(([type, featureId]) => ({ featureId, type })),
});

/** `GET structure/<home>`. */
export const homeStructure = () => ({
  structureId: STRUCTURES.home,
  name: 'Home',
  devices: [
    {
      deviceId: 'dev-1',
      productCode: 'L22',
      featureSets: [featureSet(SETS.light, 'Garden Room', FEATURE_IDS[SETS.light])],
    },
    {
      deviceId: 'dev-2',
      productCode: 'L42',
      featureSets: [featureSet(SETS.socket, 'Kitchen Socket', FEATURE_IDS[SETS.socket])],
    },
    {
      deviceId: 'dev-3',
      productCode: 'LW922',
      featureSets: [featureSet(SETS.trv, 'Bedroom Radiator', FEATURE_IDS[SETS.trv])],
    },
    {
      deviceId: 'dev-4',
      productCode: 'LW921',
      featureSets: [featureSet(SETS.boiler, 'Boiler', FEATURE_IDS[SETS.boiler])],
    },
    {
      deviceId: 'dev-5',
      productCode: 'LW931',
      featureSets: [featureSet(SETS.window, 'Bathroom Window', FEATURE_IDS[SETS.window])],
    },
    {
      deviceId: 'dev-6',
      productCode: 'L2',
      featureSets: [featureSet(SETS.hub, 'Link Plus', FEATURE_IDS[SETS.hub])],
    },
    {
      deviceId: 'dev-7',
      productCode: 'LW825',
      featureSets: [featureSet(SETS.blind, 'Lounge Blind', FEATURE_IDS[SETS.blind])],
    },
  ],
});

/** `GET structure/<cabin>`. */
export const cabinStructure = () => ({
  structureId: STRUCTURES.cabin,
  name: 'Cabin',
  devices: [
    {
      deviceId: 'dev-9',
      productCode: 'L21',
      featureSets: [featureSet(SETS.cabinLight, 'Cabin Light', FEATURE_IDS[SETS.cabinLight])],
    },
  ],
});

/** The values of every feature, by feature id (what `features/read` answers). */
export const defaultValues = () => {
  const f = FEATURE_IDS;
  return {
    [f[SETS.light].switch]: 1,
    [f[SETS.light].dimLevel]: 59,
    [f[SETS.light].protection]: 0,
    [f[SETS.light].power]: 12,
    [f[SETS.light].energy]: 12345,
    [f[SETS.socket].switch]: 0,
    [f[SETS.socket].power]: 0,
    [f[SETS.socket].outletInUse]: 0,
    [f[SETS.trv].temperature]: 195,
    [f[SETS.trv].targetTemperature]: 210,
    [f[SETS.trv].valveLevel]: 40,
    [f[SETS.trv].valveSetup]: 0,
    [f[SETS.trv].batteryLevel]: 87,
    [f[SETS.trv].rssi]: -61,
    [f[SETS.boiler].temperature]: 201,
    [f[SETS.boiler].targetTemperature]: 180,
    [f[SETS.boiler].heatState]: 1,
    [f[SETS.boiler].callForHeat]: 0,
    [f[SETS.window].windowPosition]: 1,
    [f[SETS.window].batteryLevel]: 100,
    [f[SETS.hub].buttonPress]: 0,
    [f[SETS.hub].rgbColor]: 16777215,
    [f[SETS.blind].threeWayRelay]: 0,
    [f[SETS.cabinLight].switch]: 0,
    [f[SETS.cabinLight].dimLevel]: 100,
  };
};
