import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    opengateStart: bigint | null;
    opengateKey: string | null;
    opengateClient: string | null;
  }
}
