export type MetricsSnapshot = { requestsTotal: number; allowedTotal: number; deniedTotal: number; rateLimitedTotal: number; proxyErrorsTotal: number };

export function createMetrics() {
  const values: MetricsSnapshot = { requestsTotal: 0, allowedTotal: 0, deniedTotal: 0, rateLimitedTotal: 0, proxyErrorsTotal: 0 };
  return {
    increment(name: keyof MetricsSnapshot, amount = 1) { values[name] += amount; },
    snapshot(): MetricsSnapshot { return { ...values }; },
    /** JSON is intentionally returned here; a Prometheus formatter can be
     * added later without changing counters or request instrumentation. */
    toJSON() { return this.snapshot(); }
  };
}
