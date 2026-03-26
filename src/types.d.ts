import "fastify";
import "express-serve-static-core";
import type { OpenGateRequestContext } from "./lib/types.js";

declare module "fastify" {
  interface FastifyRequest {
    opengate: OpenGateRequestContext | null;
  }
}

declare module "express-serve-static-core" {
  interface Request {
    opengate: OpenGateRequestContext | null;
  }
}
