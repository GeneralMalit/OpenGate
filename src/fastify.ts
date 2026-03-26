export {
  createOpenGate as createFastifyOpenGate,
  registerProtectedRoute
} from "./lib/gate.js";

export type {
  FastifyOpenGate,
  FastifyOperationalRoutesConfig,
  FastifyRegisterProtectedRouteConfig
} from "./lib/types.js";
