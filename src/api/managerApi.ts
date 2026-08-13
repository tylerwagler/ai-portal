export type HostKey = 'ellie' | 'sparky';

export interface ManagerModelCatalogEntry {
  id: string;
  display_name: string;
  model: string;
  backend: 'llama' | 'vllm';
  port: number;
  max_ctx: number;
  vram_base: number;
  vram_per_1k_ctx: number;
  status: 'stopped' | 'starting' | 'running' | 'error';
  update_available?: boolean | null;
  error?: string;
  progress?: number;       // 0-100 during startup
  progress_msg?: string;   // e.g. "Loading tensors 45%"
  // llama-specific
  ctx_size?: number;
  tensor_split?: string;
  parallel?: number;
  cache_type?: string;
  // vllm-specific
  served_model_name?: string;
  gpu_memory?: number;
  tp?: number;
  max_model_len?: number;
  max_num_seqs?: number;
  kv_cache_dtype?: string;
}

export interface ManagerLoadOverrides {
  // llama overrides
  ctx_size?: number;
  parallel?: number;
  cache_type?: string;
  // vllm overrides
  max_num_seqs?: number;
  kv_cache_dtype?: string;
}

export interface ManagerRunningModel {
  model_id: string;
  display_name: string;
  status: 'starting' | 'running';
  container_id: string | null;
  port: number;
  backend: string;
  gpu_memory?: number;
  uptime_seconds?: number;
  error?: string;
}

export interface ManagerHealth {
  status: string;
  models_running: number;
  models_starting: number;
  max_concurrent_models: number;
  llama_image?: string;
  llama_image_available?: boolean;
  vllm_image?: string;
  vllm_image_available?: boolean;
  gpu_memory_used?: number;
  gpu_memory_max?: number;
}

export interface ManagerModelLogs {
  model: string;
  status: string;
  logs: string;
}

export async function getManagerCatalog(host: HostKey, jwt: string): Promise<ManagerModelCatalogEntry[]> {
  const response = await fetch(`/api/${host}/catalog`, {
    headers: { 'Authorization': `Bearer ${jwt}` },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Failed to fetch ${host} model catalog`);
  }
  return response.json();
}

export async function getManagerRunning(host: HostKey, jwt: string): Promise<ManagerRunningModel[]> {
  const response = await fetch(`/api/${host}/running`, {
    headers: { 'Authorization': `Bearer ${jwt}` },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to fetch running models');
  }
  return response.json();
}

export async function loadManagerModel(host: HostKey, modelId: string, jwt: string, overrides?: ManagerLoadOverrides): Promise<void> {
  const response = await fetch(`/api/${host}/load`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify({ model: modelId, ...overrides }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to load model');
  }
}

export async function unloadManagerModel(host: HostKey, modelId: string, jwt: string): Promise<void> {
  const response = await fetch(`/api/${host}/unload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify({ model: modelId }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to unload model');
  }
}

export async function getManagerModelLogs(host: HostKey, modelId: string, jwt: string, tail: number = 200): Promise<ManagerModelLogs> {
  // Container logs can expose model paths and backend errors, so this is
  // authenticated like every other manager endpoint.
  const response = await fetch(`/api/${host}/${encodeURIComponent(modelId)}/logs?tail=${tail}`, {
    headers: { 'Authorization': `Bearer ${jwt}` },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to fetch model logs');
  }
  return response.json();
}

export interface ModelUpdateStatus {
  model_id: string;
  backend: string;
  has_update: boolean | null;
  local_ref?: string | null;
  remote_ref?: string | null;
  remote_commit?: string;
  last_modified?: string;
  checked_at: number;
  error?: string;
}

export async function checkManagerUpdates(host: HostKey, jwt: string): Promise<ModelUpdateStatus[]> {
  const response = await fetch(`/api/${host}/updates`, {
    headers: { 'Authorization': `Bearer ${jwt}` },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to check updates');
  }
  return response.json();
}

export async function refreshManagerUpdates(host: HostKey, jwt: string, modelId?: string): Promise<ModelUpdateStatus[] | ModelUpdateStatus> {
  const response = await fetch(`/api/${host}/updates/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify(modelId ? { model: modelId } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to refresh updates');
  }
  return response.json();
}

export async function updateManagerModel(host: HostKey, modelId: string, jwt: string): Promise<void> {
  const response = await fetch(`/api/${host}/update`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify({ model: modelId }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to update model');
  }
}
