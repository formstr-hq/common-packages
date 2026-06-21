import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WllamaService } from '../src/WllamaService';

const mockLoadModel = vi.fn(async () => {});
const mockCreateChatCompletion = vi.fn(async () => ({
  choices: [{ message: { content: 'hello from model' } }],
}));
const mockExit = vi.fn(async () => {});

vi.mock('@wllama/wllama/esm/index.js', () => ({
  Wllama: vi.fn().mockImplementation(function () {
    return {
      loadModel: mockLoadModel,
      createChatCompletion: mockCreateChatCompletion,
      exit: mockExit,
    };
  }),
}));

describe('WllamaService', () => {
  let cache: { put: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  let cacheOpen: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadModel.mockClear();
    mockCreateChatCompletion.mockClear();
    mockExit.mockClear();

    Object.assign(window, {
      crossOriginIsolated: true,
    });

    Object.assign(window.navigator as any, {
      gpu: {},
    });

    cache = {
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
    cacheOpen = vi.fn(async () => cache);

    Object.defineProperty(window, 'caches', {
      configurable: true,
      value: {
        open: cacheOpen,
      },
    });
  });

  describe('checkEnvironment', () => {
    it('reports browser support correctly', () => {
      const service = new WllamaService();
      expect(service.checkEnvironment()).toEqual({
        success: true,
        hasWebGPU: true,
        crossOriginIsolated: true,
      });
    });

    it('reports hasWebGPU as false when navigator.gpu is absent', () => {
      delete (window.navigator as any).gpu;
      const service = new WllamaService();
      expect(service.checkEnvironment()).toEqual({
        success: true,
        hasWebGPU: false,
        crossOriginIsolated: true,
      });
    });

    it('fails when WebAssembly is not supported', () => {
      const original = (globalThis as any).WebAssembly;
      // @ts-expect-error - simulate unsupported environment
      delete (globalThis as any).WebAssembly;

      const service = new WllamaService();
      expect(service.checkEnvironment()).toEqual({
        success: false,
        error: 'WebAssembly is not supported in this browser.',
      });

      (globalThis as any).WebAssembly = original;
    });

    it('fails when the Cache API is not supported', () => {
      delete (window as any).caches;

      const service = new WllamaService();
      expect(service.checkEnvironment()).toEqual({
        success: false,
        error: 'Cache API is not supported in this browser.',
      });
    });
  });

  describe('loadModel', () => {
    it('loads a model and caches it', async () => {
      const service = new WllamaService({ nCtx: 1024, nGpuLayers: 5 });
      const file = new File(['test'], 'model.gguf', { type: 'application/octet-stream' });

      const result = await service.loadModel(file, vi.fn());

      expect(result).toEqual({ success: true, usedWebGPU: true });
      expect(mockLoadModel).toHaveBeenCalledWith([file], {
        n_ctx: 1024,
        n_gpu_layers: 5,
      });
      expect(service.isLoaded).toBe(true);
      expect(service.currentModel).toBe('model.gguf');

      expect(cacheOpen).toHaveBeenCalledWith('wllama-local-models');
      expect(cache.put).toHaveBeenCalledWith(
        `${window.location.origin}/wllama-local-models/model.gguf`,
        expect.any(Response),
      );
    });

    it('omits n_gpu_layers when WebGPU is unsupported', async () => {
      delete (window.navigator as any).gpu;

      const service = new WllamaService({ nCtx: 1024, nGpuLayers: 5 });
      const file = new File(['test'], 'model.gguf', { type: 'application/octet-stream' });

      const result = await service.loadModel(file);

      expect(result).toEqual({ success: true, usedWebGPU: false });
      expect(mockLoadModel).toHaveBeenCalledWith([file], { n_ctx: 1024 });
    });

    it('reports progress through the onProgress callback', async () => {
      const service = new WllamaService();
      const file = new File(['test'], 'model.gguf', { type: 'application/octet-stream' });
      const onProgress = vi.fn();

      await service.loadModel(file, onProgress);

      expect(onProgress).toHaveBeenCalledWith(10);
      expect(onProgress).toHaveBeenCalledWith(30);
      expect(onProgress).toHaveBeenCalledWith(50);
      expect(onProgress).toHaveBeenCalledWith(100);
    });

    it('returns an environment error without attempting to load when unsupported', async () => {
      delete (window as any).caches;

      const service = new WllamaService();
      const file = new File(['test'], 'model.gguf', { type: 'application/octet-stream' });

      const result = await service.loadModel(file);

      expect(result).toEqual({
        success: false,
        error: 'Cache API is not supported in this browser.',
      });
      expect(mockLoadModel).not.toHaveBeenCalled();
      expect(service.isLoaded).toBe(false);
    });

    it('returns an error and resets state if the underlying loadModel call throws', async () => {
      mockLoadModel.mockRejectedValueOnce(new Error('boom'));

      const service = new WllamaService();
      const file = new File(['test'], 'model.gguf', { type: 'application/octet-stream' });

      const result = await service.loadModel(file);

      expect(result).toEqual({ success: false, error: 'boom' });
      expect(service.isLoaded).toBe(false);
      expect(service.currentModel).toBe('');
      // The wllama instance was constructed and assigned before the throw,
      // so the catch block's unload() does call exit() on it.
      expect(mockExit).toHaveBeenCalledTimes(1);
    });

    it('BUG: leaves an orphaned cache entry when loadModel throws, because modelName is only set after success', async () => {
      mockLoadModel.mockRejectedValueOnce(new Error('boom'));

      const service = new WllamaService();
      const file = new File(['test'], 'model.gguf', { type: 'application/octet-stream' });

      await service.loadModel(file);

      // storeInCache() already wrote the file into the cache before the
      // throw, but unload()'s cleanup branch checks `this.modelName`,
      // which is empty string at this point (only set on success).
      // So the cache entry written above is never deleted here.
      expect(cache.put).toHaveBeenCalledTimes(1);
      expect(cache.delete).not.toHaveBeenCalled();
    });

    it('wraps a non-Error thrown value into a string message', async () => {
      mockLoadModel.mockRejectedValueOnce('plain string failure');

      const service = new WllamaService();
      const file = new File(['test'], 'model.gguf', { type: 'application/octet-stream' });

      const result = await service.loadModel(file);

      expect(result).toEqual({ success: false, error: 'plain string failure' });
    });

    it('unloads any previously loaded model before loading a new one', async () => {
      const service = new WllamaService();
      const fileA = new File(['a'], 'a.gguf', { type: 'application/octet-stream' });
      const fileB = new File(['b'], 'b.gguf', { type: 'application/octet-stream' });

      await service.loadModel(fileA);
      await service.loadModel(fileB);

      expect(mockExit).toHaveBeenCalledTimes(1);
      expect(cache.delete).toHaveBeenCalledWith(
        `${window.location.origin}/wllama-local-models/a.gguf`,
      );
      expect(service.currentModel).toBe('b.gguf');
    });
  });

  describe('generate', () => {
    it('generates text after loading a model', async () => {
      const service = new WllamaService();
      const file = new File(['test'], 'model.gguf', { type: 'application/octet-stream' });

      await service.loadModel(file);
      const response = await service.generate({ prompt: 'hello' });

      expect(response.success).toBe(true);
      expect(response.text).toBe('hello from model');
      expect(response.timeMs).toBeGreaterThanOrEqual(0);
    });

    it('includes a system message when provided', async () => {
      const service = new WllamaService();
      const file = new File(['test'], 'model.gguf', { type: 'application/octet-stream' });

      await service.loadModel(file);
      await service.generate({ prompt: 'hello', system: 'be concise' });

      expect(mockCreateChatCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'system', content: 'be concise' },
            { role: 'user', content: 'hello' },
          ],
        }),
      );
    });

    it('applies default generation parameters', async () => {
      const service = new WllamaService();
      const file = new File(['test'], 'model.gguf', { type: 'application/octet-stream' });

      await service.loadModel(file);
      await service.generate({ prompt: 'hello' });

      expect(mockCreateChatCompletion).toHaveBeenCalledWith({
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 512,
        temperature: 0.7,
        top_k: 40,
        top_p: 0.95,
      });
    });

    it('forwards custom generation parameters', async () => {
      const service = new WllamaService();
      const file = new File(['test'], 'model.gguf', { type: 'application/octet-stream' });

      await service.loadModel(file);
      await service.generate({
        prompt: 'hello',
        maxTokens: 100,
        temperature: 0.2,
        topK: 10,
        topP: 0.5,
      });

      expect(mockCreateChatCompletion).toHaveBeenCalledWith({
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 100,
        temperature: 0.2,
        top_k: 10,
        top_p: 0.5,
      });
    });

    it('returns an error when generating before loading a model', async () => {
      const service = new WllamaService();
      const result = await service.generate({ prompt: 'hello' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No model loaded');
    });

    it('returns an empty string if the completion has no content', async () => {
      mockCreateChatCompletion.mockResolvedValueOnce({ choices: [] });

      const service = new WllamaService();
      const file = new File(['test'], 'model.gguf', { type: 'application/octet-stream' });

      await service.loadModel(file);
      const response = await service.generate({ prompt: 'hello' });

      expect(response).toEqual(
        expect.objectContaining({ success: true, text: '' }),
      );
    });

    it('returns an error if createChatCompletion throws', async () => {
      mockCreateChatCompletion.mockRejectedValueOnce(new Error('generation exploded'));

      const service = new WllamaService();
      const file = new File(['test'], 'model.gguf', { type: 'application/octet-stream' });

      await service.loadModel(file);
      const response = await service.generate({ prompt: 'hello' });

      expect(response).toEqual({ success: false, error: 'generation exploded' });
    });
  });

  describe('unload', () => {
    it('unloads the model and clears cache', async () => {
      const service = new WllamaService();
      const file = new File(['test'], 'model.gguf', { type: 'application/octet-stream' });

      await service.loadModel(file);
      await service.unload();

      expect(mockExit).toHaveBeenCalledTimes(1);
      expect(cache.delete).toHaveBeenCalledWith(
        `${window.location.origin}/wllama-local-models/model.gguf`,
      );
      expect(service.isLoaded).toBe(false);
      expect(service.currentModel).toBe('');
    });

    it('is a no-op when nothing is loaded', async () => {
      const service = new WllamaService();

      await expect(service.unload()).resolves.toBeUndefined();
      expect(mockExit).not.toHaveBeenCalled();
      expect(cache.delete).not.toHaveBeenCalled();
    });

    it('still clears state if wllama.exit() throws', async () => {
      mockExit.mockRejectedValueOnce(new Error('exit failed'));

      const service = new WllamaService();
      const file = new File(['test'], 'model.gguf', { type: 'application/octet-stream' });

      await service.loadModel(file);
      await expect(service.unload()).resolves.toBeUndefined();

      expect(service.isLoaded).toBe(false);
      expect(service.currentModel).toBe('');
    });
  });
});