# wllama-service

A framework-agnostic browser LLM service wrapper for running GGUF models locally with WebGPU acceleration and a WebAssembly fallback.

## What it is

`wllama-service` is a lightweight browser runtime wrapper around `@wllama/wllama` that:

- loads GGUF model files from the user's filesystem
- caches model bytes in the browser Cache API
- optionally uses WebGPU when available
- falls back to WebAssembly when WebGPU is unavailable
- exposes a simple service API for loading, generating, and unloading models

## Install

```bash
pnpm add wllama-service @wllama/wllama
```

## Quick start

```ts
import { WllamaService } from 'wllama-service';

const service = new WllamaService({
  wasmPath: '/wllama/wllama.wasm',
  nCtx: 2048,
  nGpuLayers: 999, // set 0 to disable WebGPU entirely
});

const env = service.checkEnvironment();
if (!env.success) {
  throw new Error(env.error);
}

const file = document.querySelector<HTMLInputElement>('#modelInput')!.files![0];
const loadResult = await service.loadModel(file, (progress) => {
  console.log(`Loading model: ${progress}%`);
});
if (!loadResult.success) {
  throw new Error(loadResult.error);
}

const result = await service.generate({
  system: 'You are a helpful assistant.',
  prompt: 'Hello, world!',
  maxTokens: 256,
  temperature: 0.7,
});

console.log(result.text);
await service.unload();
```

## Browser requirements

This package requires a browser environment with:

- `WebAssembly`
- the Cache API (`caches`)
- an optional WebGPU implementation via `navigator.gpu`

### Recommended headers for WebGPU / multithreaded WASM

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

WebGPU is optional. If the browser does not support `navigator.gpu`, the package still works using the WebAssembly path.

## Configuration

`WllamaService` accepts these options:

- `wasmPath?: string`
  - Public URL for `wllama.wasm`
  - Default: `/wllama/wllama.wasm`
- `nGpuLayers?: number`
  - Number of GPU layers to offload to WebGPU
  - Default: `999` (all layers)
  - Set to `0` to force WebAssembly-only execution
- `nCtx?: number`
  - Context window size
  - Default: `2048`

## API

### `new WllamaService(config?)`

Create a new service instance.

### `checkEnvironment()`

Returns browser capability information:

- `success: boolean`
- `error?: string`
- `hasWebGPU?: boolean`
- `crossOriginIsolated?: boolean`

### `loadModel(file, onProgress?)`

Loads a GGUF model file selected by the user. This method caches the model and may enable WebGPU if available.

- `file: File`
- `onProgress?: (progress: number) => void`

Returns:

- `success: boolean`
- `error?: string`
- `usedWebGPU?: boolean`

### `generate(request)`

Generate text from the loaded model.

Request fields:

- `prompt: string`
- `system?: string`
- `maxTokens?: number`
- `temperature?: number`
- `topK?: number`
- `topP?: number`

Returns:

- `success: boolean`
- `text?: string`
- `error?: string`
- `timeMs?: number`

### `unload()`

Unloads the current model and frees browser resources.

### `isLoaded`

Returns `true` when a model is currently loaded.

### `currentModel`

Returns the filename of the currently loaded model.

## Model asset setup

Copy `wllama.wasm` from `node_modules/@wllama/wllama/esm/wasm/wllama.wasm` into your public/static folder and serve it from the same origin.

For example:

```bash
cp node_modules/@wllama/wllama/esm/wasm/wllama.wasm public/wllama/wllama.wasm
```

Then configure the service with the same URL:

```ts
const service = new WllamaService({ wasmPath: '/wllama/wllama.wasm' });
```

## Notes

- `@wllama/wllama` is a peer dependency.
- This package is designed for browser usage only.
- If `loadModel()` fails, call `unload()` before retrying.

## License

MIT
