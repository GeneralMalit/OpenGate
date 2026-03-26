import type { OpenGateConfig, RateLimitResult, RateLimitStore, RequestIdentity } from "./types.js";
export type RedisRateLimitClient = {
    connect: () => Promise<void>;
    quit: () => Promise<void>;
    eval: (script: string, options: {
        keys: string[];
        arguments: string[];
    }) => Promise<unknown>;
};
export declare function createRateLimitStore(config: OpenGateConfig, customStore?: RateLimitStore): RateLimitStore;
export declare function createRedisRateLimitStore(config: OpenGateConfig, client?: RedisRateLimitClient): RateLimitStore;
export declare function consumeRateLimit(store: RateLimitStore, config: OpenGateConfig, identity: RequestIdentity, now?: Date): Promise<RateLimitResult>;
export declare function getCalendarDayBucket(date: Date, timeZone: string): string;
