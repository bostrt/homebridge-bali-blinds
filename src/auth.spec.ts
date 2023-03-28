import { jest, describe, it, expect } from '@jest/globals';

import {
  PortalAuthenticator,
  UserPassword,
  SessionTokenResolver,
  SessionToken,
  PortalAuth,
  DeviceResolver,
} from './auth';

import * as helper from './helper';

const validUserPass: UserPassword = {
  username: 'test-user',
  password: 'test-password',
};

const validPortlaAuthResponse = {
  // Identity (base64) {"Expires":1680055978,"PK_Account":123456}
  'Identity': 'eyJFeHBpcmVzIjoxNjgwMDU1OTc4LCJQS19BY2NvdW50IjoxMjM0NTZ9',
  'IdentitySignature': 'mock-signature',
  'Server_Account': 'swf-us-oem-account11.mios.com',
  'Server_Account_Alt': 'swf-us-oem-account12.mios.com',
};

const validDevicesResponse = {
  'Devices': [
    {
      'PK_Device': '70009999',
      'PK_DeviceType': '7',
      'PK_DeviceSubType': '2',
      'MacAddress': 'AA:AA:AA:AA:AA:AA',
      'Server_Device': 'swf-us-oem-device11.mios.com',
      'Server_Device_Alt': 'swf-us-oem-device12.mios.com',
      'PK_Installation': '1250322',
      'DeviceAssigned': '2023-01-22 23:25:54',
      'Blocked': 0,
    },
  ],
};


describe('Bali Blinds Auth', () => {
  describe('PortalAuthenticator', () => {
    it('login to MiOS portal successfully', async () => {
      const htRequestMock = jest.spyOn(helper, 'htRequest');
      htRequestMock.mockImplementationOnce(() => Promise.resolve(validPortlaAuthResponse));

      const portalAuthenticator = new PortalAuthenticator();
      const portalAuth = await portalAuthenticator.resolve(validUserPass);

      expect(portalAuth).toBeDefined();
      expect(portalAuth).not.toBeNull();
    });
    it('login to MiOS portal falure', async () => {
      const htRequestMock = jest.spyOn(helper, 'htRequest');
      htRequestMock.mockImplementationOnce(() => Promise.reject(new Error('failure')));

      const portalAuthenticator = new PortalAuthenticator();
      expect(portalAuthenticator.resolve(validUserPass)).rejects.toThrow(Error);
    });
  });

  describe('SessionTokenResolver', () => {
    it('get session token successfully', async () => {
      const htRequestMock = jest.spyOn(helper, 'htRequest');
      htRequestMock.mockImplementationOnce(() => Promise.resolve(validPortlaAuthResponse));
      htRequestMock.mockImplementationOnce(() => Promise.resolve('mock-token'));

      const portalAuthenticator = new PortalAuthenticator();
      const portalAuth = await portalAuthenticator.resolve(validUserPass);

      const sessionTokenResolver = new SessionTokenResolver();
      const sessionToken = await sessionTokenResolver.resolve(portalAuth);

      expect(sessionToken).not.toBeNull();
      expect(sessionToken.token).toBe('mock-token');
    });
    it('get session token failure', async () => {
      const htRequestMock = jest.spyOn(helper, 'htRequest');
      htRequestMock.mockImplementationOnce(() => Promise.resolve(validPortlaAuthResponse));
      htRequestMock.mockImplementationOnce(() => Promise.reject(new Error('failure')));

      const portalAuthenticator = new PortalAuthenticator();
      const portalAuth = await portalAuthenticator.resolve(validUserPass);

      const sessionTokenResolver = new SessionTokenResolver();

      expect(sessionTokenResolver.resolve(portalAuth)).rejects.toThrow(Error);
    });
  });

  describe('DeviceResolver', () => {
    it('acquire device information successfully', async () => {
      const htRequestMock = jest.spyOn(helper, 'htRequest');
      htRequestMock.mockImplementationOnce(() => Promise.resolve(validDevicesResponse));

      const portalAuth = new PortalAuth(
        validPortlaAuthResponse.Identity,
        validPortlaAuthResponse.IdentitySignature,
        '', '',
      );
      const sessionToken = new SessionToken('mock-token', portalAuth);

      const deviceResolver = new DeviceResolver();
      const deviceServer = await deviceResolver.resolve(sessionToken);

      expect(deviceServer.deviceId).toBe('70009999');
    });
    it('acquire device information failure', () => {
      const htRequestMock = jest.spyOn(helper, 'htRequest');
      htRequestMock.mockImplementationOnce(() => Promise.reject(new Error('failure')));

      const portalAuth = new PortalAuth(
        validPortlaAuthResponse.Identity,
        validPortlaAuthResponse.IdentitySignature,
        '', '',
      );
      const sessionToken = new SessionToken('mock-token', portalAuth);

      const deviceResolver = new DeviceResolver();

      expect(deviceResolver.resolve(sessionToken)).rejects.toThrow(Error);
    });
  });
});
