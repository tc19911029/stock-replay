/**
 * Simple circuit breaker for data providers.
 *
 * When a provider fails consecutively N times, the circuit "opens"
 * and skips that provider for a cooldown period, reducing latency
 * by not waiting for a known-broken source.
 *
 * States:
 * - CLOSED: Normal operation, requests go through
 * - OPEN: Provider is broken, requests are skipped
 * - HALF_OPEN: After cooldown, allow one test request
 */

interface CircuitState {
  failures: number;
  lastFailure: number;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
}

const circuits = new Map<string, CircuitState>();

const FAILURE_THRESHOLD = 5;
const COOLDOWN_MS = 60_000; // 1 minute cooldown

/** Check if a provider should be skipped */
export function isCircuitOpen(provider: string): boolean {
  const circuit = circuits.get(provider);
  if (!circuit || circuit.state === 'CLOSED') return false;

  if (circuit.state === 'OPEN') {
    // Check if cooldown has passed
    if (Date.now() - circuit.lastFailure > COOLDOWN_MS) {
      circuit.state = 'HALF_OPEN';
      return false; // Allow one test request
    }
    return true; // Still in cooldown
  }

  return false; // HALF_OPEN allows one request
}

/** Record a successful request */
export function recordSuccess(provider: string): void {
  const circuit = circuits.get(provider);
  if (circuit) {
    circuit.failures = 0;
    circuit.state = 'CLOSED';
  }
}

/** Record a failed request */
export function recordFailure(provider: string): void {
  let circuit = circuits.get(provider);
  if (!circuit) {
    circuit = { failures: 0, lastFailure: 0, state: 'CLOSED' };
    circuits.set(provider, circuit);
  }

  circuit.failures++;
  circuit.lastFailure = Date.now();

  if (circuit.failures >= FAILURE_THRESHOLD) {
    circuit.state = 'OPEN';
  }
}

/** Get circuit status for monitoring */
export function getCircuitStatus(): Record<string, { state: string; failures: number }> {
  const result: Record<string, { state: string; failures: number }> = {};
  for (const [name, circuit] of circuits) {
    result[name] = { state: circuit.state, failures: circuit.failures };
  }
  return result;
}
