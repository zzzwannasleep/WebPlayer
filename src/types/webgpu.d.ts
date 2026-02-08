// Minimal WebGPU typings shim.
// If you want full typings, consider adding `@webgpu/types` and removing this file.

export {};

declare global {
  interface Navigator {
    gpu?: any;
  }

  interface HTMLCanvasElement {
    getContext(contextId: 'webgpu', options?: any): any;
  }

  type GPUCanvasContext = any;
  type GPUAdapter = any;
  type GPUDevice = any;
  type GPURenderPipeline = any;
  type GPUBindGroupLayout = any;
  type GPUTextureFormat = any;
  const GPUShaderStage: any;
}

