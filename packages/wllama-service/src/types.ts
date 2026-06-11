export interface WllamaServiceConfig {
  /** Public URL where wllama.wasm is served from. Default: '/wllama/wllama.wasm' */
  wasmPath?: string;
  /** Number of GPU layers to offload. Default: 999 (all). Set 0 to disable WebGPU. */
  nGpuLayers?: number;
  /** Context window size. Default: 2048 */
  nCtx?: number;
}

export interface GenerateRequest {
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  topK?: number;
  topP?: number;
}

export interface GenerateResult {
  success: boolean;
  text?: string;
  error?: string;
  timeMs?: number;
}

export interface LoadModelResult {
  success: boolean;
  error?: string;
  usedWebGPU?: boolean;
}

export interface ConnectionResult {
  success: boolean;
  error?: string;
  hasWebGPU?: boolean;
  crossOriginIsolated?: boolean;
}