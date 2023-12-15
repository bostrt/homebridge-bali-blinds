import { Service, PlatformAccessory, CharacteristicValue, Logger } from 'homebridge';
import { inspect } from 'util';

import { BaliBlindsPlatform } from './platform';
import { BaliGateway, EzloIdentifier, Message, MessagePredicate } from 'bali-gateway-kit';

export const ItemUpatedPredicate = function(deviceId: EzloIdentifier): MessagePredicate {
  return (msg: Message) => msg.id === 'hub.item.updated' && msg.result.deviceId === deviceId;
};

export class BaliBlind {
  private service: Service;
  private batteryService: Service;
  private log: Logger = this.platform.log;
  private targetPosition = 0;
  private currentPosition = 0;
  private currentBatteryLevel = 100;

  constructor(
    private readonly platform: BaliBlindsPlatform,
    private readonly baliGateway: BaliGateway,
    private readonly accessory: PlatformAccessory,
    private readonly ezloid: EzloIdentifier,
    manufacturer: string,
    model: string,
  ) {
    // initialize target position storage
    this.getCurrentPosition()
      .then((value) => {
        this.targetPosition = value;
        this.currentPosition = value;
      })
      .catch((err) => {
        this.log.error(`Error setting initial target and current position on ${this} due to ${err}`);
      });

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleItemUpdated(data: Message) {
    switch (data.name) {
      case 'dimmer':
        this.service.getCharacteristic(this.platform.Characteristic.CurrentPosition).updateValue(data.value);
        this.currentPosition = data.value;
        this.service.getCharacteristic(this.platform.Characteristic.PositionState).updateValue(this.getPositionState());
        break;
      case 'switch':
        this.service.getCharacteristic(this.platform.Characteristic.TargetPosition).updateValue(data.value ? 100 : 0);
        this.targetPosition = data.value ? 100 : 0;
        this.service.getCharacteristic(this.platform.Characteristic.PositionState).updateValue(this.getPositionState());
        break;
      default:
        this.log.debug(`Could not find item for ${this} given ${inspect(data, false, null, true)}`);
        break;
    }
  }

  toString(): string {
    return `${this.accessory.displayName} (${this.ezloid})`;
  }

  async getBatteryLevel() {
    return this.baliGateway.item('battery', this.ezloid)
      .then((data) => {
        this.currentBatteryLevel = data[0].value;
        return data[0].value;
      })
      .catch((err) => {
        this.log.error(`Error getting battery level for ${this} due to ${err}`);
      });
  }

  getStatusLowBattery() {
    if (this.currentBatteryLevel < this.platform.config.lowBattery) {
      return this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW;
    } else {
      return this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }
  }

  async getCurrentPosition() {
    return this.baliGateway.item('dimmer', this.ezloid)
      .then((data) => {
        const value = data[0].value;
        this.currentPosition = value;
        return value;
      })
      .catch((err) => {
        this.log.error(`Error getting current position of ${this} due to ${err}`);
      });
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
    return this.baliGateway.item('dimmer', this.ezloid)
      .then((item) => {
        return this.baliGateway.setItemValue(item[0]._id, value)
          .then(() => {
            this.targetPosition = value as number;
          })
          .catch((err) => {
            this.log.error(`Error setting target position of ${this} due to ${err}`);
          });
      })
      .catch((err) => {
        this.log.error(`Error setting target position of ${this} due to ${inspect(err)}`);
      });
  }
}
