import { Service, PlatformAccessory, CharacteristicValue, Logger } from 'homebridge';
import { inspect } from 'util';

import { BaliBlindsPlatform } from './platform';
import { GatewaySettings } from './settings';
import { BaliGateway, EzloIdentifier, Message, MessagePredicate, UIBroadcastPredicate } from 'bali-gateway-kit';

// Item updates arrive as {id: 'ui_broadcast', msg_subclass: 'hub.item.updated', result: {deviceId, name, value, ...}}
export const ItemUpatedPredicate = function(deviceId: EzloIdentifier): MessagePredicate {
  return (msg: Message) => UIBroadcastPredicate(msg) && msg.msg_subclass === 'hub.item.updated' && msg.result?.deviceId === deviceId;
};

export class BaliBlind {
  private service: Service;
  private batteryService: Service;
  private log: Logger = this.platform.log;
  private targetPosition = 0;
  private currentPosition = 0;
  private currentBatteryLevel = 100;
  private dimmerItemId?: EzloIdentifier;
  private lastSetAt = 0;

  constructor(
    private readonly platform: BaliBlindsPlatform,
    private readonly baliGateway: BaliGateway,
    private readonly accessory: PlatformAccessory,
    private readonly ezloid: EzloIdentifier,
    manufacturer: string,
    model: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items: any[],
    private readonly settings: GatewaySettings,
  ) {
    // initialize cached state from the items fetched during discovery
    this.refresh(items, true);

    // Listen for updates
    baliGateway.addObserver(ItemUpatedPredicate(ezloid), this.handleItemUpdated.bind(this));

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, manufacturer)
      .setCharacteristic(this.platform.Characteristic.Model, model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'Default-Serial');

    // get the WindowCovering service if it exists, otherwise create a new WindowCovering service
    this.service = this.accessory.getService(this.platform.Service.WindowCovering)
      || this.accessory.addService(this.platform.Service.WindowCovering);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.name);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/WindowCovering
    //
    // Getters answer from cached state (kept fresh by gateway broadcasts and periodic refresh) so that
    // opening the Home app doesn't flood the gateway with requests that delay real commands.

    this.service.getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .onGet(this.getCurrentPosition.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(this.getPositionState.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.TargetPosition)
      .onGet(this.getTargetPosition.bind(this))
      .onSet(this.setTargetPosition.bind(this));


    // Get the Battery service if it exists, otherwise create a new Battery service
    this.batteryService = this.accessory.getService(this.platform.Service.Battery)
      || this.accessory.addService(this.platform.Service.Battery);

    this.batteryService.getCharacteristic(this.platform.Characteristic.BatteryLevel)
      .onGet(this.getBatteryLevel.bind(this));

    this.batteryService.getCharacteristic(this.platform.Characteristic.StatusLowBattery)
      .onGet(this.getStatusLowBattery.bind(this));
  }

  /**
   * Update cached state from a list of gateway items (from hub.items.list).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  refresh(items: any[], initial = false) {
    for (const item of items.filter(item => item.deviceId === this.ezloid)) {
      if (!initial) {
        this.handleItem(item);
      } else if (item.name === 'dimmer') {
        // services don't exist yet during construction, so only seed state here
        this.dimmerItemId = item._id;
        this.currentPosition = item.value;
        this.targetPosition = item.value;
      } else if (item.name === 'battery') {
        this.currentBatteryLevel = item.value;
      }
    }
  }

  private handleItemUpdated(msg: Message) {
    this.log.debug(`Received item update for ${this}: ${inspect(msg.result, false, null, true)}`);
    this.handleItem(msg.result);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleItem(item: any) {
    const Characteristic = this.platform.Characteristic;
    switch (item.name) {
      case 'dimmer':
        this.dimmerItemId = item._id ?? this.dimmerItemId;
        this.currentPosition = item.value;
        // Blind was moved from outside HomeKit (or settled), so follow the gateway's position
        if (Date.now() - this.lastSetAt > this.settings.targetGracePeriodMs) {
          this.targetPosition = item.value;
        }
        break;
      case 'switch':
        // switch only reflects open/closed, so only use it when it contradicts the target
        if (!item.value && this.targetPosition > 0) {
          this.targetPosition = 0;
        } else if (item.value && this.targetPosition === 0) {
          this.targetPosition = 100;
        }
        break;
      case 'battery':
        this.currentBatteryLevel = item.value;
        this.batteryService.getCharacteristic(Characteristic.BatteryLevel).updateValue(item.value);
        this.batteryService.getCharacteristic(Characteristic.StatusLowBattery).updateValue(this.getStatusLowBattery());
        return;
      default:
        this.log.debug(`Could not find item for ${this} given ${inspect(item, false, null, true)}`);
        return;
    }
    this.service.getCharacteristic(Characteristic.CurrentPosition).updateValue(this.currentPosition);
    this.service.getCharacteristic(Characteristic.TargetPosition).updateValue(this.targetPosition);
    this.service.getCharacteristic(Characteristic.PositionState).updateValue(this.getPositionState());
  }

  toString(): string {
    return `${this.accessory.displayName} (${this.ezloid})`;
  }

  getBatteryLevel() {
    return this.currentBatteryLevel;
  }

  getStatusLowBattery() {
    if (this.currentBatteryLevel < this.settings.lowBattery) {
      return this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW;
    } else {
      return this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }
  }

  getCurrentPosition() {
    return this.currentPosition;
  }

  getPositionState() {
    if (this.currentPosition > this.targetPosition) {
      return this.platform.Characteristic.PositionState.DECREASING;
    }
    if (this.currentPosition < this.targetPosition) {
      return this.platform.Characteristic.PositionState.INCREASING;
    }
    return this.platform.Characteristic.PositionState.STOPPED;
  }

  getTargetPosition() {
    return this.targetPosition;
  }

  async setTargetPosition(value: CharacteristicValue) {
    this.targetPosition = value as number;
    this.lastSetAt = Date.now();
    this.service.getCharacteristic(this.platform.Characteristic.PositionState).updateValue(this.getPositionState());

    try {
      // Item id is cached at startup, so this is normally a single request to the gateway
      if (this.dimmerItemId === undefined) {
        const item = await this.baliGateway.item('dimmer', this.ezloid);
        this.dimmerItemId = item[0]._id;
      }
      await this.baliGateway.setItemValue(this.dimmerItemId!, value);
    } catch (err) {
      this.log.error(`Error setting target position of ${this} due to ${inspect(err)}`);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }
}
