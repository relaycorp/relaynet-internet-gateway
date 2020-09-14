# Relaynet-Internet Gateway

This README is just a placeholder for the time being

## NATS Streaming Channels

- `pdc-parcel.${localGatewayAddress}` where `${localGatewayAddress}` is the private address of the local gateway. Parcels received via Internet-based PDCs (e.g., PoHTTP) are published on this channel.
- `internet-parcels`. Parcels bound for an internet.
- `crc-cargo`. Cargo received via CRC (e.g., CogRPC) are published here.

## Object Storage

Queued parcels and cargoes are stored in an S3-compatible bucket under the following key prefixes:

- `parcels/endpoint-bound/` for public endpoint-bound parcels. Those parcels won't stay long there because they'll either be delivered quickly or we may give up after trying for up to 24 hours. Consequently, objects in here can be automatically deleted after 24 hours.
- `parcels/gateway-bound/` for private gateway-bound parcels. It may take up to 6 months for a parcel to be collected according to the Relaynet specs, so objects here can be automatically deleted after that time.
- `cargoes/pending-unwrapping/`.

## Development

With the Docker Compose project running in the background (e.g., `docker-compose up --build --remove-orphans --abort-on-container-exit -d`), run the following commands to bootstrap the backing services.

Create Vault backend:

```
docker-compose exec -e VAULT_ADDR='http://127.0.0.1:8200' -e VAULT_TOKEN=letmein vault vault secrets enable -path=gw-keys kv-v2
```

Create MongoDB collections:

```
mongo.db.createCollection('own_certificates');
```

Create Minio buckets:

```
MC_HOST_minio=http://THE-KEY-ID:letmeinpls@object-store:9000
docker run --rm --network=relaynet-internet-gateway_default -e MC_HOST_minio minio/mc mb minio/relaynet-public-gateway
```
