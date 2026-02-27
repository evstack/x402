import { useEffect, useRef, useState } from "react";
import type { PaymentEvent } from "./useEventStream";

export interface AgentStatus {
  id: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalLatencyMs: number;
  lastSeen: number;
  lastStatus: "success" | "failed" | "pending";
}

export interface Metrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  mempoolErrors: number;
  successRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  currentTps: number;
  agents: Map<string, AgentStatus>;
  latencyHistogram: number[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function isMempoolError(message?: string): boolean {
  if (!message) return false;
  return /transaction already in mempool|already known/i.test(message);
}

// Max latency samples to keep for percentile calculations
const MAX_LATENCY_SAMPLES = 2000;

export function useMetrics(events: PaymentEvent[]): Metrics {
  const [tps, setTps] = useState(0);
  const [metrics, setMetrics] = useState<Metrics>({
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    mempoolErrors: 0,
    successRate: 0,
    avgLatencyMs: 0,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
    p99LatencyMs: 0,
    currentTps: 0,
    agents: new Map(),
    latencyHistogram: [0, 0, 0, 0, 0],
  });

  // Persistent counters that survive event buffer eviction
  const countersRef = useRef({
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    mempoolErrors: 0,
    processedCount: 0,
    agents: new Map<string, AgentStatus>(),
    latencies: [] as number[],
    latencySum: 0,
  });

  const recentRequestsRef = useRef<number[]>([]);

  // Calculate TPS every 100ms
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      recentRequestsRef.current = recentRequestsRef.current.filter((t) => now - t < 1000);
      setTps(recentRequestsRef.current.length);
    }, 100);
    return () => clearInterval(interval);
  }, []);

  // Process only new events incrementally
  useEffect(() => {
    const c = countersRef.current;
    const startIdx = c.processedCount;

    // On history reset (events array shrank), skip already-counted events
    if (events.length < startIdx) {
      // Buffer was trimmed — events we already counted were evicted.
      // Don't recount; just adjust processedCount to current length.
      c.processedCount = events.length;
      return;
    }

    let changed = false;

    for (let i = startIdx; i < events.length; i++) {
      const event = events[i];
      if (!event.agentId) continue;

      if (!c.agents.has(event.agentId)) {
        c.agents.set(event.agentId, {
          id: event.agentId,
          totalRequests: 0,
          successfulRequests: 0,
          failedRequests: 0,
          totalLatencyMs: 0,
          lastSeen: event.timestamp,
          lastStatus: "pending",
        });
      }

      const agent = c.agents.get(event.agentId)!;
      agent.lastSeen = event.timestamp;

      switch (event.type) {
        case "request_served":
          c.totalRequests++;
          c.successfulRequests++;
          agent.totalRequests++;
          agent.successfulRequests++;
          agent.lastStatus = "success";
          if (event.latencyMs) {
            c.latencies.push(event.latencyMs);
            c.latencySum += event.latencyMs;
            agent.totalLatencyMs += event.latencyMs;
            // Cap latency samples
            if (c.latencies.length > MAX_LATENCY_SAMPLES) {
              const removed = c.latencies.shift()!;
              c.latencySum -= removed;
            }
          }
          if (Date.now() - event.timestamp < 2000) {
            recentRequestsRef.current.push(event.timestamp);
          }
          changed = true;
          break;

        case "payment_failed":
        case "error":
          c.totalRequests++;
          c.failedRequests++;
          agent.failedRequests++;
          agent.lastStatus = "failed";
          if (isMempoolError(event.error)) {
            c.mempoolErrors++;
          }
          changed = true;
          break;

        case "payment_submitted":
          agent.lastStatus = "pending";
          changed = true;
          break;
      }
    }

    c.processedCount = events.length;

    if (changed) {
      const sorted = [...c.latencies].sort((a, b) => a - b);
      const avgLatencyMs = sorted.length > 0 ? c.latencySum / sorted.length : 0;

      const buckets = [0, 0, 0, 0, 0];
      for (const lat of c.latencies) {
        if (lat < 50) buckets[0]++;
        else if (lat < 100) buckets[1]++;
        else if (lat < 200) buckets[2]++;
        else if (lat < 500) buckets[3]++;
        else buckets[4]++;
      }

      const successRate =
        c.totalRequests > 0 ? (c.successfulRequests / c.totalRequests) * 100 : 0;

      setMetrics({
        totalRequests: c.totalRequests,
        successfulRequests: c.successfulRequests,
        failedRequests: c.failedRequests,
        mempoolErrors: c.mempoolErrors,
        successRate: Math.round(successRate * 10) / 10,
        avgLatencyMs: Math.round(avgLatencyMs),
        p50LatencyMs: percentile(sorted, 50),
        p95LatencyMs: percentile(sorted, 95),
        p99LatencyMs: percentile(sorted, 99),
        currentTps: tps,
        agents: new Map(c.agents),
        latencyHistogram: buckets,
      });
    }
  }, [events, tps]);

  return { ...metrics, currentTps: tps };
}
