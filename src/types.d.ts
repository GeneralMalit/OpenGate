import "fastify";
import type { OpenGateRequestContext } from "./lib/types.js";

declare module "fastify" {
  interface FastifyRequest {
    opengate: OpenGateRequestContext | null;
  }
}
