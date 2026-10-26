// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the end-to-end
// tests, so the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the feature sets of the Lightwave account.
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // Commands: on/off, brightness, target temperature and mode of the heating.
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // Configuration screen button: the test.
  gladys.onAction(ACTIONS.TEST_CONNECTION, () => app.testConnection());

  // Configuration changed by the user.
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Connection lifecycle: the first connection starts, a reconnection resends.
  // The configuration is read again; if that fails, the copy the SDK took
  // when it connected is used, so the integration never stays idle.
  gladys.on('connected', async () => {
    let config;
    try {
      config = await gladys.getConfig();
    } catch (err) {
      logger?.warn(
        `Reading the configuration failed, using the last one: ${err?.message ?? 'unknown error'}`,
      );
      config = gladys.config ?? {};
    }
    try {
      await app.connected(config);
    } catch (err) {
      logger?.error(`Start failed: ${err?.message ?? 'unknown error'}`);
    }
  });
}
