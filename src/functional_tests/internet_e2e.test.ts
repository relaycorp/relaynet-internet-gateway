import { CogRPCClient } from '@relaycorp/cogrpc';
import {
  Cargo,
  CargoCollectionAuthorization,
  CargoMessageSet,
  Certificate,
  issueDeliveryAuthorization,
  Parcel,
  ParcelCollectionAck,
  ServiceMessage,
  SessionEnvelopedData,
  SessionlessEnvelopedData,
  Signer,
} from '@relaycorp/relaynet-core';
import { PoWebClient, StreamingMode } from '@relaycorp/relaynet-poweb';
import bufferToArray from 'buffer-to-arraybuffer';
import pipe from 'it-pipe';
import uuid from 'uuid-random';

import { asyncIterableToArray, PdaChain } from '../_test_utils';
import {
  configureServices,
  GW_GOGRPC_URL,
  GW_POWEB_LOCAL_PORT,
  PONG_ENDPOINT_ADDRESS,
  runServiceCommand,
  vaultEnableSecret,
} from './services';
import { arrayToIterable, generatePdaChain, IS_GITHUB, sleep } from './utils';

configureServices([
  'poweb',
  'cogrpc',
  'pdc-outgoing-queue-worker',
  'crc-queue-worker',
  'pohttp',
  'pong',
  'pong-queue',
]);

let GW_PDA_CHAIN: PdaChain;
beforeEach(async () => {
  GW_PDA_CHAIN = await generatePdaChain();
});

beforeEach(async () => {
  await vaultEnableSecret('pong-keys');
});

test('Sending pings via PoWeb and receiving pongs via PoHTTP', async () => {
  const powebClient = PoWebClient.initLocal(GW_POWEB_LOCAL_PORT);
  const privateGatewaySigner = new Signer(
    GW_PDA_CHAIN.privateGatewayCert,
    GW_PDA_CHAIN.privateGatewayPrivateKey,
  );

  const pongEndpointSessionCertificate = await generatePongEndpointKeyPairs();
  const pingId = Buffer.from(uuid());
  const pingParcelData = await makePingParcel(
    pingId,
    pongEndpointSessionCertificate.identityCert,
    pongEndpointSessionCertificate.sessionCert,
  );

  // Deliver the ping message
  await powebClient.deliverParcel(pingParcelData.parcelSerialized, privateGatewaySigner);

  await sleep(IS_GITHUB ? 10 : 5);

  // Collect the pong message once it's been received
  const incomingParcels = await pipe(
    powebClient.collectParcels([privateGatewaySigner], StreamingMode.CLOSE_UPON_COMPLETION),
    async function* (collections): AsyncIterable<ArrayBuffer> {
      for await (const collection of collections) {
        yield collection.parcelSerialized;
        await collection.ack();
      }
    },
    asyncIterableToArray,
  );
  expect(incomingParcels).toHaveLength(1);

  await expect(deserializePong(incomingParcels[0], pingParcelData.sessionKey)).resolves.toEqual(
    pingId,
  );
});

test('Sending pings via CogRPC and receiving pongs via PoHTTP', async () => {
  const pongEndpointSessionCertificate = await generatePongEndpointKeyPairs();

  const pingId = Buffer.from(uuid());
  const pingParcelData = await makePingParcel(
    pingId,
    pongEndpointSessionCertificate.identityCert,
    pongEndpointSessionCertificate.sessionCert,
  );

  const cogRPCClient = await CogRPCClient.init(GW_GOGRPC_URL);

  // Deliver the ping message encapsulated in a cargo
  const cargoSerialized = await encapsulateParcelsInCargo([pingParcelData.parcelSerialized]);
  await asyncIterableToArray(
    cogRPCClient.deliverCargo(
      arrayToIterable([{ localId: 'random-delivery-id', cargo: cargoSerialized }]),
    ),
  );

  await sleep(IS_GITHUB ? 10 : 5);

  // Collect the pong message encapsulated in a cargo
  const collectedCargoes = await asyncIterableToArray(cogRPCClient.collectCargo(await makeCCA()));
  expect(collectedCargoes).toHaveLength(1);
  const collectedMessages = await extractMessagesFromCargo(collectedCargoes[0]);
  expect(collectedMessages).toHaveLength(2);
  expect(ParcelCollectionAck.deserialize(collectedMessages[0])).toHaveProperty(
    'parcelId',
    pingParcelData.parcelId,
  );
  await expect(deserializePong(collectedMessages[1], pingParcelData.sessionKey)).resolves.toEqual(
    pingId,
  );
});

async function generatePongEndpointKeyPairs(): Promise<{
  readonly sessionCert: Certificate;
  readonly identityCert: Certificate;
}> {
  const stdout = await runServiceCommand('pong-queue', [
    'node',
    'build/main/bin/generate-keypairs.js',
  ]);
  const stdoutLines = stdout.trim().split('\n');
  const keyData = JSON.parse(stdoutLines[stdoutLines.length - 1]);

  const initialSessionCertDer = Buffer.from(keyData.initialSessionCertificate, 'base64');
  const sessionCert = Certificate.deserialize(bufferToArray(initialSessionCertDer));

  const identityCertDer = Buffer.from(keyData.endpointCertificate, 'base64');
  const identityCert = Certificate.deserialize(bufferToArray(identityCertDer));

  return { identityCert, sessionCert };
}

async function makePingParcel(
  pingId: Buffer,
  identityCert: Certificate,
  sessionCert: Certificate,
): Promise<{
  readonly parcelId: string;
  readonly parcelSerialized: ArrayBuffer;
  readonly sessionKey: CryptoKey;
}> {
  const pongEndpointPda = await issueDeliveryAuthorization({
    issuerCertificate: GW_PDA_CHAIN.peerEndpointCert,
    issuerPrivateKey: GW_PDA_CHAIN.peerEndpointPrivateKey,
    subjectPublicKey: await identityCert.getPublicKey(),
    validityEndDate: GW_PDA_CHAIN.peerEndpointCert.expiryDate,
  });
  const pingSerialized = serializePing(pingId, pongEndpointPda);

  const serviceMessage = new ServiceMessage(
    'application/vnd.relaynet.ping-v1.ping',
    pingSerialized,
  );
  const pingEncryption = await SessionEnvelopedData.encrypt(
    serviceMessage.serialize(),
    sessionCert,
  );
  const parcel = new Parcel(
    PONG_ENDPOINT_ADDRESS,
    GW_PDA_CHAIN.peerEndpointCert,
    Buffer.from(pingEncryption.envelopedData.serialize()),
    { senderCaCertificateChain: [GW_PDA_CHAIN.privateGatewayCert] },
  );
  return {
    parcelId: parcel.id,
    parcelSerialized: await parcel.serialize(GW_PDA_CHAIN.peerEndpointPrivateKey),
    sessionKey: pingEncryption.dhPrivateKey,
  };
}

function serializePing(id: Buffer, pda: Certificate): Buffer {
  const pdaSerialized = Buffer.from(pda.serialize());
  const pdaLengthPrefix = Buffer.allocUnsafe(2);
  pdaLengthPrefix.writeUInt16LE(pdaSerialized.byteLength, 0);
  return Buffer.concat([id, pdaLengthPrefix, pdaSerialized]);
}

async function deserializePong(
  parcelSerialized: ArrayBuffer,
  sessionKey: CryptoKey,
): Promise<Buffer> {
  const parcel = await Parcel.deserialize(parcelSerialized);
  const unwrapResult = await parcel.unwrapPayload(sessionKey);
  return unwrapResult.payload.value;
}

async function encapsulateParcelsInCargo(parcels: readonly ArrayBuffer[]): Promise<Buffer> {
  const messageSet = new CargoMessageSet(parcels);
  const messageSetCiphertext = await SessionlessEnvelopedData.encrypt(
    messageSet.serialize(),
    GW_PDA_CHAIN.publicGatewayCert,
  );
  const cargo = new Cargo(
    GW_GOGRPC_URL,
    GW_PDA_CHAIN.privateGatewayCert,
    Buffer.from(messageSetCiphertext.serialize()),
  );
  return Buffer.from(await cargo.serialize(GW_PDA_CHAIN.privateGatewayPrivateKey));
}

async function makeCCA(): Promise<Buffer> {
  const cca = new CargoCollectionAuthorization(
    GW_GOGRPC_URL,
    GW_PDA_CHAIN.privateGatewayCert,
    Buffer.from([]),
  );
  return Buffer.from(await cca.serialize(GW_PDA_CHAIN.privateGatewayPrivateKey));
}

async function extractMessagesFromCargo(cargoSerialized: Buffer): Promise<readonly ArrayBuffer[]> {
  const cargo = await Cargo.deserialize(bufferToArray(cargoSerialized));
  expect(cargo.recipientAddress).toEqual(
    await GW_PDA_CHAIN.privateGatewayCert.calculateSubjectPrivateAddress(),
  );
  const { payload: cargoMessageSet } = await cargo.unwrapPayload(
    GW_PDA_CHAIN.privateGatewayPrivateKey,
  );
  return Array.from(cargoMessageSet.messages);
}