/* eslint-disable max-len */
import { Mutex } from 'async-mutex';
import crypto from 'crypto';
import url from 'url';

import { htRequest } from './helper';

interface Resolver<TAKES, GIVES> {
  resolve(token: TAKES): Promise<GIVES>;
}

/**
 * Initial authentication with MiOS using username and password.
 * @returns Promise of PortalAuth. This unexpired PortalAuth may be cached instance.
 */
export class PortalAuthenticator implements Resolver<UserPassword, PortalAuth> {
  private portalAuth?: PortalAuth;

  resolve(token: UserPassword): Promise<PortalAuth> {
    if (this.portalAuth !== undefined && this.portalAuth.expired() === false) {
      return Promise.resolve(this.portalAuth);
    }

    const endpoint =
    `https://vera-us-oem-autha11.mios.com/autha/auth/username/${token.username}?SHA1Password=${token.password}&PK_Oem=73&TokenVersion=2`;

    // TODO Cache token somehow?
    return new Promise((resolve, reject) => {
      htRequest(endpoint)
        .then((authResponse) => {
          this.portalAuth = new PortalAuth(
            authResponse.Identity,
            authResponse.IdentitySignature,
            authResponse.Server_Account_Alt,
            authResponse.Server_Account_Alt);
          resolve(this.portalAuth);
        })
        .catch((err) => {
          reject(new Error(`Failed to login to MIOS Portal due to error ${err}`));
        });
    });
  }
}

/**
 * Authenticate with the server account URL found after logging into first portal.
 * @returns Promise of SessionToken.
 */
export class SessionTokenResolver implements Resolver<PortalAuth, SessionToken> {
  resolve(portalAuth: PortalAuth): Promise<SessionToken> {
    return new Promise((resolve, reject) => {
      const endpoint =
      `https://${portalAuth.serverAccount}/info/session/token`;

      htRequest(Object.assign({}, url.parse(endpoint), {headers:  portalAuth.toHeaderRepresentation()}), '', false)
        .then((tokenResponse) => {
          const st = new SessionToken(tokenResponse, portalAuth);
          resolve(st);
        })
        .catch((err) => {
          reject(new Error(`Failed to get session token due to ${err}`));
        });
    });
  }
}

/**
 * Get device server endpoint information
 * @returns
 */
export class DeviceResolver implements Resolver<SessionToken, DeviceServer> {
  resolve(sessionToken: SessionToken): Promise<DeviceServer> {
    return new Promise((resolve, reject) => {
      const accountId = JSON.parse(Buffer.from(sessionToken.portalAuth.identity, 'base64').toString()).PK_Account;
      const endpoint =
        `https://${sessionToken.portalAuth.serverAccount}/account/account/account/${accountId}/devices`;

      htRequest(Object.assign({}, url.parse(endpoint), {headers:  sessionToken.toHeaderRepresentation()}))
        .then((devicesResponse) => {
          // TODO: Support multiple hubs per account?
          const device = devicesResponse.Devices[0];
          const dr = {
            deviceId: device.PK_Device,
            url: device.Server_Device_Alt,
            urlAlt: device.Server_Device_Alt,
            sessionToken: sessionToken,
          } as DeviceServer;
          resolve(dr);
        })
        .catch((err) => {
          reject(new Error(`Failed to get account devices due to ${err}`));
        });
    });
  }
}


/**
 * Retrieves various tokens and URLs from Bali/SWF/Vera/Mios/Ezlo/etc services that are used
 * to open a websocket connection in @class{BaliWebSocket}.
 *
 * Most of this comes from the following:
 * - https://developer.mios.com/api/legacy-cloud-api/documents/mms-api-public/
 * - https://developer.mios.com/api/legacy-cloud-api/documents/access-ezlo-hubs-remotely-and-control-devices/
 */
export class BaliResolver implements Resolver<never, ServerRelayCredentials> {
  private readonly userPass: UserPassword;
  private readonly portalAuthenticator: PortalAuthenticator;
  private readonly sessionTokenResolver: SessionTokenResolver;
  private readonly deviceResolver: DeviceResolver;
  private authMutex: Mutex = new Mutex();

  private portalAuthState?: PortalAuth;
  private deviceServerState?: DeviceServer;

  /**
   * Create new BaliResolver with username and password for your Bali Motorization app or
   * https://motorization.swfmotorization.com.
   *
   * @param username Bali Motorization username
   * @param password Bali Motorization password
   */
  constructor(username: string, password: string) {
    const passwordHash = crypto.createHash('sha1')
      .update(username.toLowerCase())
      .update(password)
      .update('oZ7QE6LcLJp6fiWzdqZc') //Salt
      .digest('hex');
    this.userPass = {username: username, password: passwordHash};

    this.portalAuthenticator = new PortalAuthenticator();
    this.sessionTokenResolver = new SessionTokenResolver();
    this.deviceResolver = new DeviceResolver();
  }

  public isExpired(): boolean {
    if (this.portalAuthState == null) {
      throw new Error("Portal auth unset");
    }
    return this.portalAuthState?.expired();
  }

  /**
 * Connect and authenticate with Bali web services.
 * @returns Promise of ServerRelayCredentials
 */
  async resolve(): Promise<ServerRelayCredentials> {
    console.log("Resolving credentials");
    await this.authMutex.acquire();

    return this.portalAuthenticator.resolve(this.userPass)
      .then((portalAuth: PortalAuth) => {
        this.portalAuthState = portalAuth;
        return this.sessionTokenResolver.resolve(portalAuth);
      })
      .then((sessionToken: SessionToken) => {
        return this.deviceResolver.resolve(sessionToken);
      })
      .then((deviceServer: DeviceServer) => {
        this.deviceServerState = deviceServer;
        const endpoint =
        `https://${deviceServer.url}/device/device/device/${deviceServer.deviceId}`;
        return htRequest(Object.assign({}, url.parse(endpoint), {headers:  deviceServer.sessionToken.toHeaderRepresentation()}));
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((response: any) => {
        const sr = {
          serverRelay: response.Server_Relay,
          deviceId: this.deviceServerState?.deviceId,
          identitySignature: this.portalAuthState?.signature,
          identityToken: this.portalAuthState?.identity,
        } as ServerRelayCredentials;
        return sr;
      })
      .finally(() => {
        this.authMutex.release();
      });
  }
}

/**
 * Encapsulates device server info
 */
export interface DeviceServer {
  readonly deviceId: string;
  readonly url: string;
  readonly urlAlt: string;
  readonly sessionToken: SessionToken;
}

/**
 * Relay credentials used when logging in via websocket.
 */
export interface ServerRelayCredentials {
    readonly serverRelay: string;
    readonly deviceId: string;
    readonly identitySignature: string;
    readonly identityToken: string;
}

/**
* Base class that encapsulates and represents an authorization crendtial
*/
interface AuthToken {
  toHeaderRepresentation(): Record<string, unknown>;
}

export interface UserPassword {
  readonly username: string;
  readonly password: string;
}

/**
* Represents, and encapsulates a MIOS portal MMS authorization crendtial
*/
export class PortalAuth implements AuthToken {
  private expiration: number;
  constructor(public identity: string,
    public signature: string,
    public serverAccount: string,
    public serverAccountAlt: string) {
    this.expiration = JSON.parse(Buffer.from(identity, 'base64').toString()).Expires;
  }

  expired(): boolean {
    const millisNow = Date.now();
    const secondsNow = Math.floor(millisNow / 1000); 
    // Use this commented line for testing. It sets expiration to ~20s.
    const expired = secondsNow > this.expiration - 86360;
    //const expired = secondsNow > this.expiration;
    return expired;
  }

  toHeaderRepresentation = (): Record<string, unknown> => {
    return { MMSAuth : this.identity, MMSAuthSig : this.signature };
  };
}

/**
 * Holds MiOS Portal MMS session token.
 */
export class SessionToken implements AuthToken {
  constructor(public token: string, public portalAuth: PortalAuth) { }

  toHeaderRepresentation = (): Record<string, unknown> => {
    return { MMSSession: this.token };
  };
}
