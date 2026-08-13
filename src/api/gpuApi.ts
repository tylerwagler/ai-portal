import type { TemperGPUMetric, GPUStats, AiServiceMetrics } from '../types/gpu';

const getApiHosts = (): string[] => {
  // Check localStorage for the configured hosts
  const configuredHosts = localStorage.getItem('temper_remote_hosts');
  if (configuredHosts) {
    try {
      return JSON.parse(configuredHosts);
    } catch {
      return [];
    }
  }

  // Legacy fallback
  const single = localStorage.getItem('temper_remote_host');
  if (single) return [single];

  // Default/Env fallback if nothing configured
  const env = import.meta.env.VITE_GPU_API_BASE;
  if (env) return [env];

  // Default to both local (via nginx proxy) and Sparky (via nginx proxy)
  return ['/api', '/api/sparky'];
};

interface BackendStatus extends AiServiceMetrics {
  host: string;
  backend: string;
  is_local: boolean;
}

interface ServiceStatusResponse {
  backends: BackendStatus[];
}

/**
 * Fetch AI service status from ai-proxy's /service/status endpoint.
 * Returns per-backend status for all configured LLM backends.
 */
async function fetchServiceStatus(): Promise<BackendStatus[]> {
  try {
    const res = await fetch('/api/service/status');
    if (!res.ok) return [];
    const data: ServiceStatusResponse = await res.json();
    return data.backends || [];
  } catch {
    return [];
  }
}

/**
 * Fetch GPU statistics from Temper API(s)
 * Aggregates results from multiple configured hosts
 */
export async function fetchGPUStats(): Promise<GPUStats> {
  const hosts = getApiHosts();

  if (hosts.length === 0) {
    // Special error to signal UI to show "Add Host" prompt
    throw new Error('NO_HOSTS_CONFIGURED');
  }

  // Fetch GPU/host metrics and service status in parallel
  const [metricsResults, backends] = await Promise.all([
    Promise.allSettled(
      hosts.map(async (host) => {
        const url = `${host.replace(/\/$/, '')}/metrics`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        // Temporary fix for backend returning invalid JSON (inf/nan)
        const rawText = await res.text();
        // Replace non-compliant numeric values with null
        const safeJson = rawText.replace(/: ?(inf|-inf|nan)/gi, ': null');

        try {
          return { host, data: JSON.parse(safeJson) };
        } catch {
          throw new Error(`Invalid JSON response from ${host}`);
        }
      })
    ),
    fetchServiceStatus(),
  ]);

  const aggregatedGpus: any[] = [];
  const aggregatedHosts: any[] = [];

  metricsResults.forEach(result => {
    if (result.status === 'fulfilled') {
      const { host, data } = result.value;

      // Determine if this host represents the local machine
      const isLocalHost = host === '/api' || host.includes('localhost') || host.includes('127.0.0.1');

      // Find matching backend from service status (prefer ready over offline)
      const candidateBackends = backends.filter(b =>
        isLocalHost ? b.is_local : !b.is_local
      );
      const matchedBackend =
        candidateBackends.find(b => b.status === 'ready') ||
        candidateBackends.find(b => b.status === 'loading') ||
        candidateBackends[0];

      // Build ai_service from matched backend (or fall back to inline ai_service for compat)
      let ai_service: AiServiceMetrics | undefined;
      if (matchedBackend) {
        ai_service = matchedBackend;
      } else if (data.ai_service) {
        // Legacy fallback: host-metrics still returning ai_service (shouldn't happen after upgrade)
        const ai = data.ai_service;
        ai_service = {
          ...ai,
          model: ai.model || ai.modelName || '',
          model_path: ai.model_path || ai.modelPath || '',
        };
      }

      aggregatedHosts.push({
        host,
        host_metrics: data.host || {},
        ai_service,
      });

      if (data.gpus && Array.isArray(data.gpus)) {
        // Add host context to each GPU
        const hostGpus = data.gpus.map((g: any) => ({
          ...g,
          host: host,
          uniqueId: `${host}-${g.index}`, // for React keys
          displayName: `${g.name} (${host})` // Optional for UI differentiation
        }));
        aggregatedGpus.push(...hostGpus);
      }
    }
    // We silently ignore failed hosts for now, or could track errors
  });

  return {
    gpus: aggregatedGpus,
    hosts: aggregatedHosts,
    driver_version: 'mixed',
    cuda_version: 'mixed'
  };
}

/**
 * Fetch individual GPU metrics (mapped from Temper's /metrics response)
 */
export async function fetchGPUMetrics(gpuId: string): Promise<TemperGPUMetric[]> {
  // Validate the GPU ID before doing any network work. The optional leading
  // minus is accepted here so that a negative index reports the specific
  // "cannot be negative" error rather than the generic format error.
  if (!gpuId || !/^-?\d+$/.test(gpuId)) {
    throw new Error('Invalid GPU ID: must be a non-empty numeric string');
  }

  const index = parseInt(gpuId, 10);
  if (index < 0) {
    throw new Error('GPU index cannot be negative');
  }

  const stats = await fetchGPUStats();

  if (index >= stats.gpus.length) {
    throw new Error(`GPU index ${index} out of range (available: 0-${stats.gpus.length - 1})`);
  }

  const gpu = stats.gpus.find((g: any) => g.index === index);
  if (!gpu) {
    // This should never happen due to the range check above, but keep as safety net
    throw new Error(`GPU index ${index} not found`);
  }

  return [gpu];
}
