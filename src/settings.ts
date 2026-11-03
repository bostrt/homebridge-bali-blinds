/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'BaliBlinds';

/**
 * This must match the name of your plugin as defined the package.json
 */
export const PLUGIN_NAME = 'homebridge-bali-blinds';

/**
 * Per-gateway settings, resolved from the gateway's config with defaults applied
 */
export interface GatewaySettings {
  // Battery percentage below which blinds report low battery
  lowBattery: number;
  // Max time to wait on the gateway (opening the connection, login, or any request) before failing
  requestTimeoutMs: number;
  // How often to resync all blind state from the gateway, in case an update was missed. 0 disables.
  refreshIntervalMs: number;
  // How long after a HomeKit command to keep its target before gateway reports may override it
  targetGracePeriodMs: number;
}

export const DEFAULT_LOW_BATTERY = 33;
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 10;
export const DEFAULT_REFRESH_INTERVAL_SECONDS = 300;
export const DEFAULT_TARGET_GRACE_PERIOD_SECONDS = 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveGatewaySettings(gatewayConfig: any): GatewaySettings {
  const number = (value: unknown, fallback: number, min: number) =>
    typeof value === 'number' && value >= min ? value : fallback;

  return {
    lowBattery: number(gatewayConfig.lowBattery, DEFAULT_LOW_BATTERY, 0),
    requestTimeoutMs: number(gatewayConfig.requestTimeout, DEFAULT_REQUEST_TIMEOUT_SECONDS, 1) * 1000,
    refreshIntervalMs: number(gatewayConfig.refreshInterval, DEFAULT_REFRESH_INTERVAL_SECONDS, 0) * 1000,
    targetGracePeriodMs: number(gatewayConfig.targetGracePeriod, DEFAULT_TARGET_GRACE_PERIOD_SECONDS, 0) * 1000,
  };
}
