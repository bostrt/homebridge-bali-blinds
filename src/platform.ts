import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { BaliBlind } from './platformAccessory';
import { BaliCloudResolver, BaliGateway, HubIdentifier } from 'bali-gateway-kit';

import EventEmitter from 'events';


export class BaliBlindsPlatform extends EventEmitter implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

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
      if (config.baliUsername === undefined || config.baliPassword === undefined) {
        this.log.error('Missing Bali username and password');
        return;
      }

      // Discover and register devices
      this.discoverDevices()
        .catch((err) => {
          this.log.error(`Error encounted during setup: ${err}`);
        });
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
  async discoverDevices() {
    this.log.info('Discover devices');
    const credentialsResolver = new BaliCloudResolver(this.config.baliUsername, this.config.baliPassword);
    let gatewayId: HubIdentifier;

    if (this.config.baliGatewayId) {
      gatewayId = this.config.baliGatewayId;
    } else {
      const hubs = await credentialsResolver.hubs();
      if (hubs.length === 0) {
        this.log.error('No Bali Gateway devices found');
        return;
      }
      gatewayId = hubs[0];
      this.log.info(`Auto-selecting first Bali Gateway: ${gatewayId}`);
    }

    const gateway = await BaliGateway.createHub(gatewayId, credentialsResolver);
    await gateway.connect();

    this.api.on('shutdown', async() => {
      await gateway.disconnect();
    });
    const devices = await gateway.devices();
    this.log.info(`Discovered ${devices.length} devices`);
    await this.setupDevices(devices, gateway);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async setupDevices(devices: any[], baliGateway: BaliGateway) {
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
        new BaliBlind(this, baliGateway, existingAccessory, device._id, device.info.manufacturer, device.info.model);

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
        new BaliBlind(this, baliGateway, accessory, device._id, device.info.manufacturer, device.info.model);

        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}
