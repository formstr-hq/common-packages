import { Wllama } from '@wllama/wllama/esm/index.js';
import type {
  WllamaServiceConfig,
  GenerateRequest,
  GenerateResult,
  LoadModelResult,
  ConnectionResult,
} from './types';

interface WllamaInstance {
  loadModel(files: File[], options: { n_ctx: number; n_gpu_layers?: number }): Promise<void>;
  createChatCompletion(params: {
    messages: Array<{ role: string; content: string }>;
    max_tokens: number;
    temperature: number;
    top_k: number;
    top_p: number;
  }): Promise<{ choices?: Array<{ message?: { content?: string } }> }>;
  exit(): Promise<void>;
}

type WllamaConstructor = new (config: { default: string }) => WllamaInstance;

function isWebGPUSupported(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WllamaService {
  private wllama: WllamaInstance | null = null;
  private modelName = '';
  private config: Required<WllamaServiceConfig>;

  constructor(config: WllamaServiceConfig = {}) {
    this.config = {
      wasmPath: config.wasmPath ?? '/wllama/wllama.wasm',
      nGpuLayers: config.nGpuLayers ?? 999,
      nCtx: config.nCtx ?? 2048,
    };
  }

  /** Check browser compatibility and capabilities */
  checkEnvironment(): ConnectionResult {
    if (typeof WebAssembly === 'undefined') {
      return { success: false, error: 'WebAssembly is not supported in this browser.' };
    }
    if (!('caches' in window)) {
      return { success: false, error: 'Cache API is not supported in this browser.' };
    }

    return {
      success: true,
      hasWebGPU: isWebGPUSupported(),
      crossOriginIsolated: window.crossOriginIsolated,
    };
  }

  /** Load a GGUF model file from the user's filesystem */
  async loadModel(
    file: File,
    onProgress?: (progress: number) => void,
  ): Promise<LoadModelResult> {
    const env = this.checkEnvironment();
    if (!env.success) return { success: false, error: env.error };

    await this.unload();

    try {
      onProgress?.(10);

      const configPaths = { default: this.config.wasmPath };
      const WllamaConstructor = Wllama as unknown as WllamaConstructor;
      this.wllama = new WllamaConstructor(configPaths);
      onProgress?.(30);

      await this.storeInCache(file);
      onProgress?.(50);

      const hasWebGPU = isWebGPUSupported();
      await this.wllama.loadModel([file], {
        n_ctx: this.config.nCtx,
        ...(hasWebGPU && this.config.nGpuLayers > 0
          ? { n_gpu_layers: this.config.nGpuLayers }
          : {}),
      });

      this.modelName = file.name;
      onProgress?.(100);

      return { success: true, usedWebGPU: hasWebGPU };
    } catch (error: unknown) {
      await this.unload();
      return { success: false, error: extractErrorMessage(error) };
    }
  }

  /** Generate a response from the loaded model */
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (!this.wllama) {
      return { success: false, error: 'No model loaded. Call loadModel() first.' };
    }

    try {
      const t0 = performance.now();
      const messages: Array<{ role: string; content: string }> = [];
      if (req.system) messages.push({ role: 'system', content: req.system });
      messages.push({ role: 'user', content: req.prompt });

      const response = await this.wllama.createChatCompletion({
        messages,
        max_tokens: req.maxTokens ?? 512,
        temperature: req.temperature ?? 0.7,
        top_k: req.topK ?? 40,
        top_p: req.topP ?? 0.95,
      });

      const text = response?.choices?.[0]?.message?.content ?? '';
      return {
        success: true,
        text,
        timeMs: Math.round(performance.now() - t0),
      };
    } catch (error: unknown) {
      return { success: false, error: extractErrorMessage(error) || 'Generation failed' };
    }
  }

  /** Unload the current model and free memory */
  async unload(): Promise<void> {
    if (this.wllama) {
      try {
        await this.wllama.exit();
      } catch {
        // ignore cleanup failures
      }
      this.wllama = null;
    }

    if (this.modelName) {
      try {
        await this.deleteFromCache(this.modelName);
      } catch {
        // ignore cleanup failures
      }
      this.modelName = '';
    }
  }

  /** Whether a model is currently loaded */
  get isLoaded(): boolean {
    return this.wllama !== null;
  }

  /** Name of the currently loaded model */
  get currentModel(): string {
    return this.modelName;
  }

  private async storeInCache(file: File): Promise<void> {
    const url = `${window.location.origin}/wllama-local-models/${file.name}`;
    const cache = await caches.open('wllama-local-models');
    await cache.put(url, new Response(file, {
      headers: { 'Content-Type': 'application/octet-stream' },
    }));
  }

  private async deleteFromCache(fileName: string): Promise<void> {
    const url = `${window.location.origin}/wllama-local-models/${fileName}`;
    const cache = await caches.open('wllama-local-models');
    await cache.delete(url);
  }
}