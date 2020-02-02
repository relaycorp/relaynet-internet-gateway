import { Parcel } from '@relaycorp/relaynet-core';
import { mongoose } from '@typegoose/typegoose';
import { FastifyInstance, FastifyReply } from 'fastify';

import { retrieveOwnCertificates } from '../certs';
import { publishMessage } from '../nats';

export default async function registerRoutes(
  fastify: FastifyInstance,
  _options: any,
): Promise<void> {
  fastify.route({
    method: ['PUT', 'DELETE', 'PATCH'],
    url: '/',
    async handler(_req, reply): Promise<void> {
      reply
        .code(405)
        .header('Allow', 'HEAD, GET, POST')
        .send();
    },
  });

  fastify.route({
    method: ['HEAD', 'GET'],
    url: '/',
    async handler(_req, reply): Promise<void> {
      reply
        .code(200)
        .header('Content-Type', 'text/plain')
        .send('Success! This PoHTTP endpoint for the gateway works.');
    },
  });

  fastify.route({
    method: 'POST',
    url: '/',
    async handler(request, reply): Promise<FastifyReply<any>> {
      if (request.headers['content-type'] !== 'application/vnd.relaynet.parcel') {
        return reply.code(415).send();
      }

      // tslint:disable-next-line:no-let
      let parcel;
      try {
        parcel = await Parcel.deserialize(request.body);
      } catch (error) {
        return reply.code(400).send({ message: 'Payload is not a valid RAMF-serialized parcel' });
      }

      // @ts-ignore
      const mongooseConnection = (fastify.mongo as unknown) as { readonly db: mongoose.Connection };
      const trustedCertificates = await retrieveOwnCertificates(mongooseConnection.db);
      try {
        await parcel.validate(trustedCertificates);
      } catch (error) {
        // tslint:disable-next-line:no-console
        console.log({
          attachedChain: [
            await parcel.senderCaCertificateChain[0].calculateSubjectPrivateAddress(),
            await parcel.senderCaCertificateChain[1].calculateSubjectPrivateAddress(),
          ],
          attachedChainCount: parcel.senderCaCertificateChain.length,
          err: error.message,
          recipient: parcel.recipientAddress,
          sender: await parcel.senderCertificate.calculateSubjectPrivateAddress(),
          trusted: await trustedCertificates[0].calculateSubjectPrivateAddress(),
          trustedCount: trustedCertificates.length,
        });

        // @ts-ignore
        const certPath = await parcel.getSenderCertificationPath(trustedCertificates);
        // tslint:disable-next-line:prefer-for-of no-let
        for (let i = 0; i < certPath.length; i++) {
          // tslint:disable-next-line:no-console
          console.log({
            addr: await certPath[i].calculateSubjectPrivateAddress(),
            i,
            total: certPath.length,
          });
        }
        // return reply.code(400).send({ message: 'Parcel sender is not authorized' });
      }

      // @ts-ignore
      const certificatePath = await parcel.getSenderCertificationPath(trustedCertificates);
      const localGateway = certificatePath[0];
      const localGatewayAddress = await localGateway.calculateSubjectPrivateAddress();
      try {
        await publishMessage(request.body, `crc-parcel.${localGatewayAddress}`);
      } catch (error) {
        request.log.error({ err: error }, 'Failed to queue ping message');
        return reply
          .code(500)
          .send({ message: 'Parcel could not be stored; please try again later' });
      }
      return reply.code(202).send({});
    },
  });
}
