// Prometheus-compatible metrics — counters, histograms, gauges.
//
// The spec: "metrics (Prometheus-compatible)" + "Observability — traces
// (OpenTelemetry), logs (Pino), metrics (Prometheus-compatible), dashboards
// (Grafana + PostHog + Vercel), alerts, on-call rotation, runbooks."
//
// This is a minimal in-memory metrics registry that exposes a /api/metrics
// endpoint in Prometheus text format. For production scale, this would be
// replaced by `prom-client` (the standard Node.js Prometheus client) + a
// Grafana dashboard. This implementation provides the same primitives
// (Counter, Histogram, Gauge) in a lightweight, dependency-free form.
//
// Metric types:
//   - Counter: monotonically increasing (e.g. http_requests_total).
//   - Gauge:   arbitrary value (e.g. active_sessions, in_flight_requests).
//   - Histogram: bucketed distribution (e.g. http_request_duration_seconds).
//
// Labels: all metrics support labels (e.g. {method, route, status}).

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type MetricType = "counter" | "gauge" | "histogram";

export interface MetricLabels {
  [key: string]: string;
}

interface MetricBase {
  name: string;
  help: string;
  type: MetricType;
}

interface CounterMetric extends MetricBase {
  type: "counter";
  values: Map<string, number>; // key = labelKey, value = count.
}

interface GaugeMetric extends MetricBase {
  type: "gauge";
  values: Map<string, number>;
}

interface HistogramMetric extends MetricBase {
  type: "histogram";
  buckets: number[]; // the bucket upper bounds.
  counts: Map<string, number[]>; // per-label bucket counts.
  sums: Map<string, number>;
  counts_total: Map<string, number>;
}

// ───────────────────────────────────────────────
// Registry
// ───────────────────────────────────────────────

const counters = new Map<string, CounterMetric>();
const gauges = new Map<string, GaugeMetric>();
const histograms = new Map<string, HistogramMetric>();

/** Create or get a counter. */
export function counter(name: string, help: string): Counter {
  let c = counters.get(name);
  if (!c) {
    c = { name, help, type: "counter", values: new Map() };
    counters.set(name, c);
  }
  return new Counter(c);
}

/** Create or get a gauge. */
export function gauge(name: string, help: string): Gauge {
  let g = gauges.get(name);
  if (!g) {
    g = { name, help, type: "gauge", values: new Map() };
    gauges.set(name, g);
  }
  return new Gauge(g);
}

/** Create or get a histogram. */
export function histogram(name: string, help: string, buckets: number[] = DEFAULT_BUCKETS): Histogram {
  let h = histograms.get(name);
  if (!h) {
    h = { name, help, type: "histogram", buckets: [...buckets].sort((a, b) => a - b), counts: new Map(), sums: new Map(), counts_total: new Map() };
    histograms.set(name, h);
  }
  return new Histogram(h);
}

// Default histogram buckets (seconds — Prometheus convention).
export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// ───────────────────────────────────────────────
// Counter
// ───────────────────────────────────────────────

export class Counter {
  constructor(private metric: CounterMetric) {}

  inc(labels: MetricLabels = {}, value: number = 1): void {
    if (value < 0) throw new Error("counter can only increase");
    const key = labelKey(labels);
    const current = this.metric.values.get(key) ?? 0;
    this.metric.values.set(key, current + value);
  }

  get(labels: MetricLabels = {}): number {
    return this.metric.values.get(labelKey(labels)) ?? 0;
  }
}

// ───────────────────────────────────────────────
// Gauge
// ───────────────────────────────────────────────

export class Gauge {
  constructor(private metric: GaugeMetric) {}

  set(labels: MetricLabels = {}, value: number): void {
    this.metric.values.set(labelKey(labels), value);
  }

  inc(labels: MetricLabels = {}, value: number = 1): void {
    const key = labelKey(labels);
    const current = this.metric.values.get(key) ?? 0;
    this.metric.values.set(key, current + value);
  }

  dec(labels: MetricLabels = {}, value: number = 1): void {
    this.inc(labels, -value);
  }

  get(labels: MetricLabels = {}): number {
    return this.metric.values.get(labelKey(labels)) ?? 0;
  }
}

// ───────────────────────────────────────────────
// Histogram
// ───────────────────────────────────────────────

export class Histogram {
  constructor(private metric: HistogramMetric) {}

  observe(labels: MetricLabels = {}, value: number): void {
    const key = labelKey(labels);
    let counts = this.metric.counts.get(key);
    if (!counts) {
      counts = new Array(this.metric.buckets.length).fill(0);
      this.metric.counts.set(key, counts);
    }
    // Increment each bucket whose upper bound >= value.
    for (let i = 0; i < this.metric.buckets.length; i++) {
      if (value <= this.metric.buckets[i]!) {
        counts[i]!++;
      }
    }
    const sum = this.metric.sums.get(key) ?? 0;
    this.metric.sums.set(key, sum + value);
    const total = this.metric.counts_total.get(key) ?? 0;
    this.metric.counts_total.set(key, total + 1);
  }

  get(labels: MetricLabels = {}): { buckets: number[]; counts: number[]; sum: number; count: number } {
    const key = labelKey(labels);
    return {
      buckets: this.metric.buckets,
      counts: this.metric.counts.get(key) ?? new Array(this.metric.buckets.length).fill(0),
      sum: this.metric.sums.get(key) ?? 0,
      count: this.metric.counts_total.get(key) ?? 0,
    };
  }
}

// ───────────────────────────────────────────────
// Serialization — Prometheus text format
// ───────────────────────────────────────────────

/**
 * Serialize all metrics to Prometheus text format (for the /api/metrics endpoint).
 *
 * Format:
 *   # HELP metric_name help text
 *   # TYPE metric_name counter|gauge|histogram
 *   metric_name{label="value"} 42
 *   metric_name_bucket{label="value",le="0.005"} 0
 *   metric_name_bucket{label="value",le="+Inf"} 100
 *   metric_name_sum{label="value"} 12.34
 *   metric_name_count{label="value"} 100
 */
export function serializeMetrics(): string {
  const lines: string[] = [];

  // Counters.
  for (const c of counters.values()) {
    lines.push(`# HELP ${c.name} ${c.help}`);
    lines.push(`# TYPE ${c.name} counter`);
    for (const [key, value] of c.values) {
      lines.push(`${c.name}${formatLabels(parseLabelKey(key))} ${value}`);
    }
  }

  // Gauges.
  for (const g of gauges.values()) {
    lines.push(`# HELP ${g.name} ${g.help}`);
    lines.push(`# TYPE ${g.name} gauge`);
    for (const [key, value] of g.values) {
      lines.push(`${g.name}${formatLabels(parseLabelKey(key))} ${value}`);
    }
  }

  // Histograms.
  for (const h of histograms.values()) {
    lines.push(`# HELP ${h.name} ${h.help}`);
    lines.push(`# TYPE ${h.name} histogram`);
    for (const [key, counts] of h.counts) {
      const labels = parseLabelKey(key);
      for (let i = 0; i < h.buckets.length; i++) {
        lines.push(`${h.name}_bucket${formatLabels({ ...labels, le: String(h.buckets[i]) })} ${counts[i]}`);
      }
      lines.push(`${h.name}_bucket${formatLabels({ ...labels, le: "+Inf" })} ${h.counts_total.get(key) ?? 0}`);
      lines.push(`${h.name}_sum${formatLabels(labels)} ${h.sums.get(key) ?? 0}`);
      lines.push(`${h.name}_count${formatLabels(labels)} ${h.counts_total.get(key) ?? 0}`);
    }
  }

  return lines.join("\n") + "\n";
}

// ───────────────────────────────────────────────
// Label helpers
// ───────────────────────────────────────────────

function labelKey(labels: MetricLabels): string {
  return JSON.stringify(labels);
}

function parseLabelKey(key: string): MetricLabels {
  try {
    return JSON.parse(key) as MetricLabels;
  } catch {
    return {};
  }
}

function formatLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  const parts = entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  return `{${parts.join(",")}}`;
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

// ───────────────────────────────────────────────
// Pre-defined metrics (the standard set)
// ───────────────────────────────────────────────

/** HTTP request metrics (recorded by the middleware). */
export const httpRequestTotal = counter("http_requests_total", "Total HTTP requests");
export const httpRequestDuration = histogram(
  "http_request_duration_seconds",
  "HTTP request duration in seconds",
  [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
);
export const httpRequestInFlight = gauge("http_requests_in_flight", "Currently in-flight HTTP requests");

/** AI metrics. */
export const aiCallsTotal = counter("ai_calls_total", "Total AI provider calls");
export const aiCallDuration = histogram(
  "ai_call_duration_seconds",
  "AI call duration in seconds",
  [0.5, 1, 2, 5, 10, 30, 60],
);
export const aiFirstTokenDuration = histogram(
  "ai_first_token_seconds",
  "AI first-token latency in seconds",
  [0.1, 0.25, 0.5, 1, 2, 5],
);
export const aiCostTotal = counter("ai_cost_usd_total", "Total AI cost in USD");

/** Background job metrics. */
export const jobDuration = histogram(
  "background_job_duration_seconds",
  "Background job duration in seconds",
  [1, 5, 10, 30, 60, 120, 300],
);
export const jobTotal = counter("background_jobs_total", "Total background jobs");
export const jobFailures = counter("background_job_failures_total", "Background job failures");

/** Circuit breaker metrics. */
export const circuitBreakerState = gauge("circuit_breaker_state", "Circuit breaker state (0=closed, 1=half_open, 2=open)");
export const circuitBreakerRejected = counter("circuit_breaker_rejected_total", "Requests rejected by circuit breaker");

/** DB pool metrics. */
export const dbPoolSize = gauge("db_pool_size", "Database connection pool size");
export const dbPoolWaiting = gauge("db_pool_waiting", "Database pool waiting count");
