import { EnvVarError } from 'env-var';
import * as http from 'http';
import * as https from 'https';

import { asyncIterableToArray, mockSpy } from '../_test_utils';
import { configureMockEnvVars, getMockContext } from '../services/_test_utils';

const mockS3Client = {
  deleteObject: mockSpy(jest.fn(), () => ({ promise: () => Promise.resolve() })),
  getObject: mockSpy(jest.fn(), () => ({ promise: () => Promise.resolve({}) })),
  listObjectsV2: mockSpy(jest.fn(), () => ({ promise: () => Promise.resolve({ Contents: [] }) })),
  putObject: mockSpy(jest.fn(), () => ({ promise: () => Promise.resolve() })),
};
jest.mock('aws-sdk', () => ({
  S3: jest.fn().mockReturnValue(mockS3Client),
}));
import * as AWS from 'aws-sdk';
import { ObjectStoreClient, StoreObject } from './objectStorage';

const SECRET_ACCESS_KEY = 'secret-access-key';
const ACCESS_KEY = 'the-access-key';
const ENDPOINT = 'the-endpoint';

const BUCKET = 'the-bucket';
const OBJECT_KEY = 'the-object.txt';
const OBJECT: StoreObject = { body: Buffer.from('the-body'), metadata: { foo: 'bar' } };

describe('ObjectStore', () => {
  const CLIENT = new ObjectStoreClient(ENDPOINT, ACCESS_KEY, SECRET_ACCESS_KEY);

  describe('Constructor', () => {
    describe('Client', () => {
      test('Specified endpoint should be used', () => {
        // tslint:disable-next-line:no-unused-expression
        new ObjectStoreClient(ENDPOINT, ACCESS_KEY, SECRET_ACCESS_KEY);

        expect(AWS.S3).toBeCalledTimes(1);

        const s3CallArgs = getMockContext(AWS.S3).calls[0][0];
        expect(s3CallArgs).toHaveProperty('endpoint', ENDPOINT);
      });

      test('Specified credentials should be used', () => {
        // tslint:disable-next-line:no-unused-expression
        new ObjectStoreClient(ENDPOINT, ACCESS_KEY, SECRET_ACCESS_KEY);

        expect(AWS.S3).toBeCalledTimes(1);

        const s3CallArgs = getMockContext(AWS.S3).calls[0][0];
        expect(s3CallArgs).toHaveProperty('accessKeyId', ACCESS_KEY);
        expect(s3CallArgs).toHaveProperty('secretAccessKey', SECRET_ACCESS_KEY);
      });

      test('Signature should use version 4', () => {
        // tslint:disable-next-line:no-unused-expression
        new ObjectStoreClient(ENDPOINT, ACCESS_KEY, SECRET_ACCESS_KEY);

        expect(AWS.S3).toBeCalledTimes(1);

        const s3CallArgs = getMockContext(AWS.S3).calls[0][0];
        expect(s3CallArgs).toHaveProperty('signatureVersion', 'v4');
      });

      test('s3ForcePathStyle should be enabled', () => {
        // tslint:disable-next-line:no-unused-expression
        new ObjectStoreClient(ENDPOINT, ACCESS_KEY, SECRET_ACCESS_KEY);

        expect(AWS.S3).toBeCalledTimes(1);

        const s3CallArgs = getMockContext(AWS.S3).calls[0][0];
        expect(s3CallArgs).toHaveProperty('s3ForcePathStyle', true);
      });

      test('TSL should be enabled by default', () => {
        // tslint:disable-next-line:no-unused-expression
        new ObjectStoreClient(ENDPOINT, ACCESS_KEY, SECRET_ACCESS_KEY);

        expect(AWS.S3).toBeCalledTimes(1);

        const s3CallArgs = getMockContext(AWS.S3).calls[0][0];
        expect(s3CallArgs).toHaveProperty('sslEnabled', true);
      });

      test('TSL may be disabled', () => {
        // tslint:disable-next-line:no-unused-expression
        new ObjectStoreClient(ENDPOINT, ACCESS_KEY, SECRET_ACCESS_KEY, false);

        expect(AWS.S3).toBeCalledTimes(1);

        const s3CallArgs = getMockContext(AWS.S3).calls[0][0];
        expect(s3CallArgs).toHaveProperty('sslEnabled', false);
      });

      describe('HTTP(S) agent', () => {
        test('HTTP agent with Keep-Alive should be used when TSL is disabled', () => {
          // tslint:disable-next-line:no-unused-expression
          new ObjectStoreClient(ENDPOINT, ACCESS_KEY, SECRET_ACCESS_KEY, false);

          expect(AWS.S3).toBeCalledTimes(1);

          const s3CallArgs = getMockContext(AWS.S3).calls[0][0];
          const agent = s3CallArgs.httpOptions.agent;
          expect(agent).toBeInstanceOf(http.Agent);
          expect(agent).toHaveProperty('keepAlive', true);
        });

        test('HTTPS agent with Keep-Alive should be used when TSL is enabled', () => {
          // tslint:disable-next-line:no-unused-expression
          new ObjectStoreClient(ENDPOINT, ACCESS_KEY, SECRET_ACCESS_KEY, true);

          expect(AWS.S3).toBeCalledTimes(1);

          const s3CallArgs = getMockContext(AWS.S3).calls[0][0];
          const agent = s3CallArgs.httpOptions.agent;
          expect(agent).toBeInstanceOf(https.Agent);
          expect(agent).toHaveProperty('keepAlive', true);
        });
      });
    });
  });

  describe('initFromEnv', () => {
    const baseEnvVars = {
      OBJECT_STORE_ACCESS_KEY_ID: 'the-access-key-id',
      OBJECT_STORE_ENDPOINT: 'objects.example.com:9000',
      OBJECT_STORE_SECRET_KEY: 'the-secret-key',
    };
    const mockEnvVars = configureMockEnvVars(baseEnvVars);

    test.each(['OBJECT_STORE_ENDPOINT', 'OBJECT_STORE_ACCESS_KEY_ID', 'OBJECT_STORE_SECRET_KEY'])(
      '%s should be required',
      (envVarKey: string) => {
        mockEnvVars({ ...baseEnvVars, [envVarKey]: undefined });

        expect(() => ObjectStoreClient.initFromEnv()).toThrowWithMessage(
          EnvVarError,
          new RegExp(envVarKey),
        );
      },
    );

    test('OBJECT_STORE_TLS_ENABLED should be honored if present', () => {
      mockEnvVars({ ...baseEnvVars, OBJECT_STORE_TLS_ENABLED: 'false' });

      ObjectStoreClient.initFromEnv();

      expect(AWS.S3).toBeCalledTimes(1);
      const s3CallArgs = getMockContext(AWS.S3).calls[0][0];
      expect(s3CallArgs).toHaveProperty('sslEnabled', false);
    });

    test('TLS should be enabled if OBJECT_STORE_TLS_ENABLED is missing', () => {
      mockEnvVars({ ...baseEnvVars, OBJECT_STORE_TLS_ENABLED: undefined });

      ObjectStoreClient.initFromEnv();

      expect(AWS.S3).toBeCalledTimes(1);
      const s3CallArgs = getMockContext(AWS.S3).calls[0][0];
      expect(s3CallArgs).toHaveProperty('sslEnabled', true);
    });

    test('Environment variables should be passed to constructor', () => {
      mockEnvVars({ ...baseEnvVars, OBJECT_STORE_TLS_ENABLED: undefined });

      ObjectStoreClient.initFromEnv();

      expect(AWS.S3).toBeCalledTimes(1);
      const s3CallArgs = getMockContext(AWS.S3).calls[0][0];
      expect(s3CallArgs).toMatchObject<AWS.S3.Types.ClientConfiguration>({
        accessKeyId: baseEnvVars.OBJECT_STORE_ACCESS_KEY_ID,
        endpoint: baseEnvVars.OBJECT_STORE_ENDPOINT,
        secretAccessKey: baseEnvVars.OBJECT_STORE_SECRET_KEY,
      });
    });

    test('Client should be returned', () => {
      mockEnvVars({ ...baseEnvVars, OBJECT_STORE_TLS_ENABLED: undefined });

      expect(ObjectStoreClient.initFromEnv()).toBeInstanceOf(ObjectStoreClient);
    });
  });

  describe('listObjectKeys', () => {
    const PREFIX = 'prefix/';

    test('Filter criteria should be honored', async () => {
      await asyncIterableToArray(CLIENT.listObjectKeys(PREFIX, BUCKET));

      expect(mockS3Client.listObjectsV2).toBeCalledTimes(1);
      expect(mockS3Client.listObjectsV2).toBeCalledWith({
        Bucket: BUCKET,
        Prefix: PREFIX,
      });
    });

    test('Keys for objects matching criteria should be yielded', async () => {
      const objectKeys: readonly string[] = [`${PREFIX}logo.png`, `${PREFIX}logo.gif`];
      mockS3Client.listObjectsV2.mockReturnValue({
        promise: () =>
          Promise.resolve({
            Contents: objectKeys.map((k) => ({ Key: k })),
            IsTruncated: false,
          }),
      });

      const retrievedKeys = await asyncIterableToArray(CLIENT.listObjectKeys(PREFIX, BUCKET));

      expect(retrievedKeys).toEqual(objectKeys);
    });

    test('Pagination should be handled seamlessly', async () => {
      const objectKeys1: readonly string[] = [`${PREFIX}logo.png`, `${PREFIX}logo.gif`];
      const continuationToken = 'continue==';
      mockS3Client.listObjectsV2.mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Contents: objectKeys1.map((k) => ({ Key: k })),
            ContinuationToken: continuationToken,
            IsTruncated: true,
          }),
      });
      const objectKeys2: readonly string[] = [`${PREFIX}style.css`, `${PREFIX}mobile.css`];
      mockS3Client.listObjectsV2.mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Contents: objectKeys2.map((k) => ({ Key: k })),
            IsTruncated: false,
          }),
      });

      const retrievedKeys = await asyncIterableToArray(CLIENT.listObjectKeys(PREFIX, BUCKET));

      expect(retrievedKeys).toEqual([...objectKeys1, ...objectKeys2]);

      expect(mockS3Client.listObjectsV2).toBeCalledTimes(2);
      expect(mockS3Client.listObjectsV2).toBeCalledWith({
        Bucket: BUCKET,
        ContinuationToken: continuationToken,
        Prefix: PREFIX,
      });
    });
  });

  describe('getObject', () => {
    test('Object should be retrieved with the specified parameters', async () => {
      await CLIENT.getObject(OBJECT_KEY, BUCKET);

      expect(mockS3Client.getObject).toBeCalledTimes(1);
      expect(mockS3Client.getObject).toBeCalledWith({
        Bucket: BUCKET,
        Key: OBJECT_KEY,
      });
    });

    test('Body and metadata should be output', async () => {
      mockS3Client.getObject.mockReturnValue({
        promise: () =>
          Promise.resolve({
            Body: OBJECT.body,
            Metadata: OBJECT.metadata,
          }),
      });

      const object = await CLIENT.getObject(OBJECT_KEY, BUCKET);

      expect(object).toHaveProperty('body', OBJECT.body);
      expect(object).toHaveProperty('metadata', OBJECT.metadata);
    });

    test('Metadata should fall back to empty object when undefined', async () => {
      mockS3Client.getObject.mockReturnValue({
        promise: () =>
          Promise.resolve({
            Body: OBJECT.body,
          }),
      });

      const object = await CLIENT.getObject(OBJECT_KEY, BUCKET);

      expect(object).toHaveProperty('body', OBJECT.body);
      expect(object).toHaveProperty('metadata', {});
    });
  });

  describe('putObject', () => {
    test('Object should be created with specified parameters', async () => {
      await CLIENT.putObject(OBJECT, OBJECT_KEY, BUCKET);

      expect(mockS3Client.putObject).toBeCalledTimes(1);
      expect(mockS3Client.putObject).toBeCalledWith({
        Body: OBJECT.body,
        Bucket: BUCKET,
        Key: OBJECT_KEY,
        Metadata: OBJECT.metadata,
      });
    });
  });

  describe('deleteObject', () => {
    test('Specified object should be deleted', async () => {
      await CLIENT.deleteObject(OBJECT_KEY, BUCKET);

      expect(mockS3Client.deleteObject).toBeCalledTimes(1);
      expect(mockS3Client.deleteObject).toBeCalledWith({
        Bucket: BUCKET,
        Key: OBJECT_KEY,
      });
    });
  });
});
