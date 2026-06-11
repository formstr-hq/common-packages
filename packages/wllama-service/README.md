# wllama-service

A framework-agnostic browser LLM service wrapper built on [@wllama/wllama](https://github.com/ngxson/wllama).
Runs GGUF models locally in the browser with WebGPU acceleration and WebAssembly fallback.

## Browser requirements

This package requires a browser environment with:

- `WebAssembly` support
- `Cache API` support in the browser
- optional WebGPU via `navigator.gpu`
- recommended secure cross-origin headers for WebGPU and multi-threaded WASM:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The `checkEnvironment()` API can be used to detect whether the current browser supports the required features, and WebGPU is treated as an optional acceleration path.

## Requirements

Copy `wllama.wasm` from `node_modules/@wllama/wllama/esm/wasm/wllama.wasm` to your public folder
and pass its URL via `wasmPath`.

## Install

```bash
npm install wllama-service @wllama/wllama
```

## Usage

```typescript
import { WllamaService } from 'wllama-service';

const service = new WllamaService({
  wasmPath: '/wllama/wllama.wasm', // path in your public folder
  nCtx: 2048,
  nGpuLayers: 999, // set 0 to disable WebGPU
});

// Check browser support
const env = service.checkEnvironment();
console.log('WebGPU available:', env.hasWebGPU);

// Load a GGUF file from file input
const result = await service.loadModel(file, (progress) => {
  console.log(`Loading: ${progress}%`);
});

// Generate
const response = await service.generate({
  system: 'You are a helpful assistant.',
  prompt: 'Hello!',
  maxTokens: 256,
  temperature: 0.7,
});

console.log(response.text);
console.log(`Generated in ${response.timeMs}ms`);

// Unload when done
await service.unload();
```