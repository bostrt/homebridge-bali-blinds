/* eslint-disable @typescript-eslint/no-explicit-any */
import { inspect } from 'util';
import WebSocket from 'ws';
import { ServerRelayCredentials } from './auth';
import { randomUUID } from 'crypto';
import { Mutex } from 'async-mutex';
import { Logger } from 'homebridge';
import { backOff } from 'exponential-backoff';

export declare type EzloIdentifier = string;


// Observer framework for distributing websocket responses based on the Request ID
declare type RequestID = string;
declare type ObserverFunc = (message: any) => void;

export class BaliWebsocket {
  private websocket!: WebSocket;
  private _isConnected = false;
  private connectMutex = new Mutex();

  private requestObservers: Map<RequestID, ObserverFunc>;
  private itemUpdateObservers: Map<EzloIdentifier, ObserverFunc>;

  constructor(public relay: ServerRelayCredentials, private log: Logger) {
    this.setupWebsocket();
    this.requestObservers = new Map<RequestID, ObserverFunc>();
    this.itemUpdateObservers = new Map<EzloIdentifier, ObserverFunc>();
    this.requestObservers.set('ui_broadcast', this.handleBroadcast.bind(this));
  }

  private setupWebsocket() {
    // Create the websocket and register observer dispatch handlers
    // NOTE: Override ECC ciphers to prevent over-burdening crytpo on Atom w/ESP32
    this.log.debug(`Opening websocket to ${this.relay.serverRelay}`);
    this.websocket = new WebSocket(this.relay.serverRelay, { rejectUnauthorized: false, ciphers: 'AES256-SHA256' });

    this.websocket.addListener('message', this.distributeMesssage.bind(this));

    this.websocket.addListener('error', (err) => {
      this.log.error('ERROR');
      this.log.error(inspect(err, false, null, true));
    });
    this.websocket.addListener('close', async () => {
      this.log.error('CLOSED');
      await this.disconnect();
      this.setupWebsocket();
      await this.reconnect();
    });
  }


  async disconnect(): Promise<any> {
    return this.connectMutex.acquire()
      .then(async (release) => {
        this._isConnected = false;
        release();
      })
      .catch((err) => {
        this.log.error(inspect(err, false, null, true));
      });
  }

  public isConnected(): boolean {
    return this._isConnected;
  }

  private async reconnect(): Promise<BaliWebsocket> {
    return backOff(() => {
      return this.connect();
    });
  }

  public async connect(): Promise<BaliWebsocket> {
    return this.connectMutex.acquire()
      .then(async (release) => {
        return backOff(async () => {
          return this.doConnect()
            .finally(() => release());
        });
      });
  }

  private async doConnect(): Promise<BaliWebsocket> {
    if (this.isConnected()) {
      return Promise.resolve(this);
    }

    return new Promise((resolve, reject) => {
      this.waitOpen()
        .then(() => {
          return this.send(JSON.stringify({method: 'loginUserMios',
            id: randomUUID(),
            params: { PK_Device: this.relay.deviceId,
              MMSAuthSig: this.relay.identitySignature,
              MMSAuth: this.relay.identityToken }}));
        })
        .then((response: any) => {
          if (response.error !== null && response.error.data !== 'user.login.alreadylogged') {
            reject(new Error(`Login failed due to error ${response.error.data}`));
          }
          this._isConnected = true;
        })
        .then(() => {
          return this.send(JSON.stringify({method: 'register',
            id: randomUUID(),
            params: {
              'serial': this.relay.deviceId,
            }}));
        })
        .then((response: any) => {
          if (response.error !== null) {
            reject(new Error(`Device registration failed due to ${response.error.data}`));
          }
          resolve(this);
        })
        .catch(err => {
          reject(new Error(`Login failed - unable to connect due to error ${err}`));
        })
        .finally(() => {
          //
        });
    });
  }

  waitOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.websocket.once('open', () => resolve());
      this.websocket.once('error', (err) => reject(new Error(`Could not open websocket due to ${err}`)));
    });
  }

  /**
   * Information about the hub such as architecture, build, model, serial #, etc.
   *
   * @returns an info object
   */
  public info(): Promise<Record<string, unknown>> {
    return this.sendRequest({ method: 'hub.info.get', params: {} });
  }

  /**
   * Devices paired with the hub
   *
   * @returns collection of devices
   */
  public devices(): Promise<Array<any>> {
    return this.sendRequest({ method: 'hub.devices.list', params: {} }).then(res => res.devices);
  }

  /**
   * Device with name
   *
   * @param name - device name
   * @returns devices with name
   */
  public device(name: EzloIdentifier): Promise<EzloIdentifier> {
    return this.devices().then(devices => devices.filter(dev => dev.name === name)[0]);
  }

  /**
   * Collection of items, optionally limited to a device
   *
   * @param EzloIdentifier - optional, only return items for device 'id'
   * @returns collection of items
   */
  public items(device?: EzloIdentifier): Promise<any[]> {
    const request = {
      method: 'hub.items.list',
      params: {},
    };
    if (device) {
      request.params = {deviceIds: [device]};
    }
    return this.sendRequest(request).then(res => res.items);
  }

  /**
   * Collection of items with name, optionally limited to a device
   *
   * @param device - optional, only return items for device 'id'
   * @returns collection of items | undefined if no items with name exist
   */
  public item(name: EzloIdentifier, device?: EzloIdentifier): Promise<any[]> {
    return this.items(device).then(items => items.filter(item => item.name === name));
  }

  /**
   * Set the value for one or more items.  In the case of multiple items,
   * a z-wave multicast message will be sent to the list of items
   *
   * @param items - items for which to set value
   * @param value - the value to set on item
   */
  public setItemValue(items: EzloIdentifier | [EzloIdentifier], value: unknown): Promise<any> {
    let params;
    if (typeof items === 'string') {
      params = {_id: items, value: value};
    } else {
      params = {ids: items, value: value};  //multicast
    }
    return this.sendRequest({method: 'hub.item.value.set', params: params});
  }

  private addRequestObserver(id: RequestID, func: ObserverFunc) {
    this.requestObservers.set(id, func);
  }

  private removeRequestObserver(id: RequestID) {
    this.requestObservers.delete(id);
  }

  public addItemObserver(id: EzloIdentifier, func: ObserverFunc) {
    this.itemUpdateObservers.set(id, func);
  }

  private handleBroadcast(response: any) {
    try {
    // Handle ui_broadcast messages specially and foward to another observer
      if (response.msg_subclass && response.msg_subclass === 'hub.item.updated') {
        const deviceObs = this.itemUpdateObservers.get(response.result.deviceId);
        if (deviceObs === undefined) {
          this.log.debug(`Could not find observer for deviceId ${inspect(response, false, null, true)}`);
          return;
        }
        this.log.debug(`Received ui_broadcast ${inspect(response, false, null, true)}`);
        deviceObs(response.result);
      } else {
        this.log.warn(`Unknown broadcast ${inspect(response, false, null, true)}`);
      }
    } catch (err) {
      this.log.error(`${err}`);
    }
  }

  private distributeMesssage(response: WebSocket.RawData) {
    try {
      const data = JSON.parse(response.toString());
      const observer = this.requestObservers.get(data.id);
      if (observer === undefined) {
        this.log.warn(`Could not find request ID in response ${response}`);
        return;
      } else {
        observer(data);
      }
    } catch (err) {
      this.log.error(`${err}`);
    }
  }

  private async listenForMyRequest(requestId): Promise<any> {
    return new Promise((resolve) => {
      this.addRequestObserver(requestId, resolve);
    })
      .finally(() => {
        this.removeRequestObserver(requestId);
      });
  }

  /**
   * Send a json-rpc request to the hub and parse the result
   *
   * @param request - json-rpc request object
   * @returns the json parsed result object from the response json.
   */
  private sendRequest(request: Record<string, unknown>): Promise<any> {
    if (request.id !== null) {
      request.id = randomUUID();
    }
    return new Promise((resolve, reject) => {
      this.connect()
        .then(() => {
          this.websocket.send(JSON.stringify(request));
        })
        .then(() => {
          return this.listenForMyRequest(request.id);
        })
        .then((response) => {
          if (response.error !== null) {
            return reject(
              new Error(`Request failed with ${response.error.data} - Request: ${JSON.stringify(request)}`),
            );
          }
          resolve(response.result);
        })
        .catch(err => {
          this.log.error('Request to %s failed: %O\nResult: %O', this, request, err);
          reject(new Error(`Request failed due to error ${err}`));
        });
    });
  }

  private send(outgoing: string): Promise<any> {
    return new Promise((resolve, reject) => {
      this.websocket.once('error', (err) => reject(new Error(`Websocket closed with error due to ${err}`)));
      this.websocket.once('message', (data) => {
        try {
          resolve(JSON.parse(data.toString()));
        } catch (err) {
          reject(new Error(`Error receiving wss message due to ${err}`));
        }
      });
      this.websocket.send(outgoing);
    });
  }
}
