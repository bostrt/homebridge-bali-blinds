import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { GatewaySettings, PLATFORM_NAME, PLUGIN_NAME, resolveGatewaySettings } from './settings';
import { BaliBlind } from './platformAccessory';
import { BaliCloudResolver, BaliGateway, HubIdentifier } from 'bali-gateway-kit';

import EventEmitter from 'events';

/**
 * Works around two bali-gateway-kit issues that can leave every later request waiting forever:
 *
 * - connect() holds its connect lock while calling initialize(), but never releases it if initialize()
 *   throws (e.g. a network error while refreshing cloud credentials), so release it ourselves.
 * - The websocket has no timeouts, so a relay that never answers (during login inside connect(), or
 *   any request) hangs. initialize() creates a new websocket whenever credentials change, so the
 *   timeout is reapplied after each call.
 *
 * Must be applied after createHub(), so that initialize() is only ever called from within connect().
 */
export function hardenGateway(gateway: BaliGateway, timeoutMs: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = gateway as any;
  const applyTimeout = () => {
    internals.wsp._options.timeout = timeoutMs;
  };
  const initialize = gateway.initialize.bind(gateway);
  gateway.initialize = async () => {
    try {
      await initialize();
      applyTimeout();
    } catch (err) {
      internals.connectMutex.release();
      throw err;
    }
  };
  applyTimeout();
}


export class BaliBlindsPlatform extends EventEmitter implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  private known_gateways: string[] = [];

  private connectionState = {
    serverRelay: '',
    deviceId: '',
    identitySignature: '',
    identityToken: '',
  };

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    super();
    this.log.debug(`Finished initializing platform: ${PLATFORM_NAME}(${PLUGIN_NAME})`);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', async () => {
      // Check if old configuration is still being used
      if (config.baliUsername || config.baliPassword || config.baliGatewayId) {
        // eslint-disable-next-line max-len
        this.log.warn('You are using a deprecated configuration. Please follow this guide to update your configuration: https://github.com/bostrt/homebridge-bali-blinds?tab=readme-ov-file#configuration');
        // Migrate into new configuration and continue
        config.gateways = [config];
      }

      // Ensure list of gateways is not empty
      {
        if (config.gateways === undefined || config.gateways.length === 0) {
          this.log.error('No Bali Gateways configured');
          return;
        }
      }

      // Ensure each gateway has username and password
      for (const key in config.gateways) {
        const gateway = config.gateways[key];
        if (gateway.baliUsername === undefined || gateway.baliPassword === undefined) {
          this.log.error('A Bali Gateway configuration is missing username and/or password');
          continue;
        }
        // Discover and register devices for the Gateway
        await this.discoverDevices(gateway)
          .catch((err) => {
            this.log.error(`Error encounted during setup: ${err}`);
          });
      }
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  async discoverDevices(gateway_config) {
    this.log.info('Discover devices');
    const settings = resolveGatewaySettings(gateway_config);
    const credentialsResolver = new BaliCloudResolver(gateway_config.baliUsername, gateway_config.baliPassword);
    let gatewayId: HubIdentifier;

    if (gateway_config.baliGatewayId) {
      gatewayId = gateway_config.baliGatewayId;
    } else {
      const hubs = await credentialsResolver.hubs();
      if (hubs.length === 0) {
        this.log.error('No Bali Gateway devices found');
        return;
      }
      gatewayId = hubs[0];
      this.log.info(`Auto-selecting first Bali Gateway: ${gatewayId}`);
    }

    if (this.known_gateways.includes(gatewayId)) {
      this.log.warn(`Gateway ${gatewayId} is already configured... Skipping duplicate config`);
      return;
    } else {
      this.known_gateways.push(gatewayId);
    }

    const gateway = await BaliGateway.createHub(gatewayId, credentialsResolver);
    hardenGateway(gateway, settings.requestTimeoutMs);
    await gateway.connect();

    const devices = await gateway.devices();
    this.log.info(`Discovered ${devices.length} devices`);
    // Fetch every item in one request rather than one request per blind
    const items = await gateway.items();
    const blinds = await this.setupDevices(devices, items, gateway, settings);
    this.log.info(`Sucessfully configured gateway ${gatewayId}`);

    // Background resync of all blind state, in case a gateway broadcast was missed. This also keeps the
    // cloud credentials and websocket fresh, so reconnects happen here instead of on a user's command.
    const refreshTimer = settings.refreshIntervalMs > 0 ? setInterval(() => {
      gateway.items()
        .then((items) => blinds.forEach((blind) => blind.refresh(items)))
        .catch((err) => this.log.warn(`Error refreshing blinds on gateway ${gatewayId}: ${err}`));
    }, settings.refreshIntervalMs) : undefined;

    this.api.on('shutdown', async() => {
      clearInterval(refreshTimer);
      await gateway.disconnect();
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async setupDevices(devices: any[], items: any[], baliGateway: BaliGateway, settings: GatewaySettings): Promise<BaliBlind[]> {
    const blinds: BaliBlind[] = [];
    // loop over the discovered devices and register each one if it has not already been registered
    for (const device of devices) {
      // generate a unique id for the accessory this should be generated from
      // something globally unique, but constant, for example, the device serial
      // number or MAC address
      if (device.category !== 'window_cov') {
        continue;
      }
      const uuid = this.api.hap.uuid.generate(device._id);

      // see if an accessory with the same uuid has already been registered and restored from
      // the cached devices we stored in the `configureAccessory` method above
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      //const data = await baliWebsocket.items();
      //console.log(data);

      if (existingAccessory) {
        // the accessory already exists
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
        // existingAccessory.context.device = device;
        // this.api.updatePlatformAccessories([existingAccessory]);

        // create the accessory handler for the restored accessory
        // this is imported from `platformAccessory.ts`
        blinds.push(new BaliBlind(this, baliGateway, existingAccessory, device._id, device.info.manufacturer, device.info.model,
          items, settings));

        // it is possible to remove platform accessories at any time using `api.unregisterPlatformAccessories`, eg.:
        // remove platform accessories when no longer present
        // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
        // this.log.info('Removing existing accessory from cache:', existingAccessory.displayName);
      } else {
        // the accessory does not yet exist, so we need to create it
        this.log.info('Adding new accessory:', device.name);

        // create a new accessory
        const accessory = new this.api.platformAccessory(device.name, uuid);

        // store a copy of the device object in the `accessory.context`
        // the `context` property can be used to store any data about the accessory you may need
        accessory.context.device = device;

        // create the accessory handler for the newly create accessory
        // this is imported from `platformAccessory.ts`
        blinds.push(new BaliBlind(this, baliGateway, accessory, device._id, device.info.manufacturer, device.info.model, items, settings));

        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
    return blinds;
  }
}
