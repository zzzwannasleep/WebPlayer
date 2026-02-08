const VIDEO_SHADER_WGSL = /* wgsl */ `
struct VsOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vertexIndex : u32) -> VsOut {
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
  );

  var uvs = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(1.0, 0.0),
  );

  var out : VsOut;
  out.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  out.uv = uvs[vertexIndex];
  return out;
}

@group(0) @binding(0) var videoTex : texture_external;

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  let color = textureSampleBaseClampToEdge(videoTex, in.uv);
  return vec4<f32>(color.rgb, 1.0);
}
`;

export class WebGPURenderer {
  readonly kind = 'webgpu' as const;

  private canvas: HTMLCanvasElement | null = null;
  private context: GPUCanvasContext | null = null;
  private device: GPUDevice | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private format: GPUTextureFormat | null = null;

  async init(canvas: HTMLCanvasElement) {
    if (!navigator.gpu) throw new Error('WebGPU not supported in this browser');
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('WebGPU canvas context not available');

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('Failed to request WebGPU adapter');

    const device = await adapter.requestDevice();
    const format = navigator.gpu.getPreferredCanvasFormat();

    context.configure({
      device,
      format,
      alphaMode: 'premultiplied',
    });

    const shaderModule = device.createShaderModule({ code: VIDEO_SHADER_WGSL });
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          externalTexture: {},
        },
      ],
    });

    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module: shaderModule, entryPoint: 'vs' },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.canvas = canvas;
    this.context = context;
    this.device = device;
    this.format = format;
    this.pipeline = pipeline;
    this.bindGroupLayout = bindGroupLayout;
  }

  render(source: VideoFrame | HTMLVideoElement) {
    if (!this.context || !this.device || !this.pipeline || !this.bindGroupLayout)
      return;

    const externalTexture = this.device.importExternalTexture({
      source: source as any,
    });

    const bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: externalTexture }],
    });

    const commandEncoder = this.device.createCommandEncoder();
    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6, 1, 0, 0);
    pass.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }

  destroy() {
    this.canvas = null;
    this.context = null;
    this.device = null;
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.format = null;
  }
}
