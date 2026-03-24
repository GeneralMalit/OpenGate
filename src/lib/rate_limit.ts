import { RateLimiterMemory } from "rate-limiter-flexible";
import type { Config } from "./config.js";

export type RateLimiter = {
  consume: (key: string) => Promise<void>;
  remainingPoints: (key: string) => Promise<number>;
};

export function createRateLimiter(config: Config): RateLimiter {
  const limiter = new RateLimiterMemory({
    points: config.rate_limit.points,
    duration: config.rate_limit.duration
  });

  return {
    async consume(key: string) {
      await limiter.consume(key);
    },
    async remainingPoints(key: string) {
      const res = await limiter.get(key);
      return res?.remainingPoints ?? config.rate_limit.points;
    }
  };
}
