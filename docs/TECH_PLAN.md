# Web 全能视频播放器技术方案

## 项目定位
基于 WebAssembly FFmpeg + WebGPU 的高性能网页播放器，支持全格式视频、图形字幕(SUP/PGS)和特效字幕(ASS)，采用分层加载策略平衡功能与体积。

---

## 技术栈

| 层级 | 技术选择 | 体积 |
|------|----------|------|
| 框架 | **SolidJS** (响应式，无虚拟DOM) | ~7KB |
| 样式 | **Tailwind CSS** (按需生成) | ~15KB |
| 语言 | **TypeScript** (ES2020目标) | - |
| 渲染 | **WebGPU** (主) + Canvas 2D (回退) | - |
| 硬解 | **WebCodecs API** | 内置 |
| 软解 | **FFmpeg.wasm** (流式加载) | 25MB (后台) |

---

## 架构设计

```
┌─────────────────────────────────────┐
│  UI 层 (SolidJS + Tailwind)         │
│  - 播放控制 / 字幕选择 / 设置面板     │
├─────────────────────────────────────┤
│  渲染层 (WebGPU)                    │
│  - YUV→RGB 转换 / 字幕叠加 / HDR处理  │
├─────────────────────────────────────┤
│  解码策略 (智能选择)                 │
│  - WebCodecs 硬解 (优先)             │
│  - 轻量软解模块 (按需加载)            │
│  - FFmpeg.wasm (终极后备)            │
├─────────────────────────────────────┤
│  解封装层 (按需加载)                 │
│  - MP4/MKV/MPEG-TS 分离器            │
├─────────────────────────────────────┤
│  字幕引擎                            │
│  - ASS/SSA 解析 + WebGPU 特效渲染     │
│  - SUP/PGS 位图解码 + GPU 叠加        │
└─────────────────────────────────────┘
```

---

## 目录结构

```
src/
├── core/
│   ├── player.ts              # 播放器主控
│   ├── buffer-manager.ts      # 环形缓冲区
│   └── clock.ts               # 音视频同步
├── render/
│   ├── webgpu-renderer.ts     # WebGPU 渲染器
│   ├── yuv-shaders.wgsl       # YUV 转换着色器
│   └── canvas2d-fallback.ts   # 2D 回退
├── demux/
│   ├── mp4-demuxer.ts         # MP4 解封装 (50KB)
│   ├── mkv-demuxer.ts         # MKV 解封装 (40KB)
│   └── ts-demuxer.ts          # MPEG-TS (30KB)
├── decode/
│   ├── webcodecs-decoder.ts   # 硬解接口
│   ├── wasm-loader.ts         # Wasm 加载器
│   └── codec-loader.ts        # 动态导入管理
├── subtitle/
│   ├── ass-parser.ts          # ASS/SSA 解析 (30KB)
│   ├── ass-renderer.ts        # 特效渲染 (WebGPU)
│   ├── sup-decoder.ts         # PGS 位图解码 (25KB)
│   └── renderer.ts            # 字幕合成
├── utils/
│   ├── prefetch.ts            # 智能预加载
│   └── streaming-wasm.ts      # 流式编译
└── components/                # SolidJS UI 组件
    ├── Player.tsx
    ├── Controls.tsx
    └── SubtitleSelector.tsx
```

---

## 关键实现策略

### 1. 三层加载策略

| 阶段 | 内容 | 体积 | 加载时机 |
|------|------|------|----------|
| **核心** | 播放器 + UI + WebGPU | 250KB | 首屏 |
| **模块** | 解封装器 + 软解器 | 1-5MB | 播放时按需 |
| **后备** | FFmpeg.wasm | 25MB | 后台流式加载 |

### 2. 解码优先级
```typescript
1. WebCodecs API (硬解) - H.264/H.265/VP9/AV1
2. 轻量 WASM 解码器 (按需) - 特定格式
3. FFmpeg.wasm (终极后备) - 全格式支持
```

### 3. 字幕渲染方案
- **ASS 基础样式**: Canvas 2D (简单标签)
- **ASS 特效** (`\blur`, `\move`, `\t`): WebGPU 计算着色器
- **SUP/PGS**: 解码为 ImageBitmap → WebGPU 纹理叠加

---

## 依赖库清单

```json
{
  "dependencies": {
    "solid-js": "^1.8.0",
    "tailwindcss": "^3.4.0",
    "ass-compiler": "^0.1.0",
    "mp4box": "^2.1.1",
    "@ffmpeg/ffmpeg": "^0.12.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "vite": "^5.0.0",
    "vite-plugin-solid": "^2.8.0"
  }
}
```

---

## 核心代码模板

### 播放器主控 (core/player.ts)
```typescript
interface PlayerConfig {
  canvas: HTMLCanvasElement;
  useWebGPU: boolean;
  wasmPath?: string;
}

class WebPlayer {
  private renderer: WebGPURenderer | Canvas2DRenderer;
  private demuxer: BaseDemuxer;
  private videoDecoder: VideoDecoder;
  private audioDecoder: AudioDecoder;
  private subtitleEngine: SubtitleEngine;
  
  async loadFile(file: File) {
    // 1. 探测格式
    const format = await detectFormat(file);
    
    // 2. 加载对应解封装器 (动态导入)
    this.demuxer = await this.loadDemuxer(format);
    
    // 3. 获取轨道信息
    const tracks = await this.demuxer.parseHeader();
    
    // 4. 初始化解码器 (硬解优先)
    await this.initDecoders(tracks);
    
    // 5. 开始播放循环
    this.startPlayback();
  }
  
  private async initDecoders(tracks: MediaTracks) {
    // 视频: 优先 WebCodecs
    if (await supportsHardwareDecoding(tracks.video.codec)) {
      this.videoDecoder = new VideoDecoder({
        output: (frame) => this.renderer.renderVideoFrame(frame)
      });
    } else {
      // 回退软解
      const { SoftDecoder } = await import('./soft-decoder.js');
      this.videoDecoder = new SoftDecoder();
    }
    
    // 字幕: 根据类型初始化
    if (tracks.subtitle.format === 'ASS') {
      this.subtitleEngine = new ASSEngine();
    } else if (tracks.subtitle.format === 'PGS') {
      this.subtitleEngine = new PGSEngine();
    }
  }
}
```

### WebGPU 渲染器 (render/webgpu-renderer.ts)
```typescript
class WebGPURenderer {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  
  async init(canvas: HTMLCanvasElement) {
    const adapter = await navigator.gpu.requestAdapter();
    this.device = await adapter.requestDevice();
    
    // 创建 YUV→RGB 渲染管线
    this.pipeline = this.device.createRenderPipeline({
      vertex: {
        module: this.device.createShaderModule({
          code: YUV_VERTEX_SHADER
        })
      },
      fragment: {
        module: this.device.createShaderModule({
          code: YUV_FRAGMENT_SHADER
        }),
        targets: [{ format: 'bgra8unorm' }]
      }
    });
  }
  
  renderVideoFrame(videoFrame: VideoFrame) {
    // 导入 VideoFrame 为 GPUExternalTexture (零拷贝)
    const externalTexture = this.device.importExternalTexture({
      source: videoFrame
    });
    
    // 渲染到画布
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    
    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.createBindGroup(externalTexture));
    passEncoder.draw(6); // 全屏四边形
    passEncoder.end();
  }
  
  renderSubtitle(bitmap: ImageBitmap, x: number, y: number, opacity: number) {
    // 字幕叠加渲染 (使用混合模式)
  }
}
```

### ASS 字幕引擎 (subtitle/ass-renderer.ts)
```typescript
import { parseASS } from 'ass-compiler';

class ASSEngine {
  private parsedScript: ASSScript;
  private gpuRenderer: ASSGPURenderer;
  
  load(content: string) {
    this.parsedScript = parseASS(content);
  }
  
  render(time: number): ImageBitmap | null {
    const activeDialogues = this.getActiveDialogues(time);
    if (activeDialogues.length === 0) return null;
    
    // 检查是否需要 GPU 特效
    const needsGPU = activeDialogues.some(d => 
      d.tags.animation || d.tags.blur || d.tags.move
    );
    
    if (needsGPU) {
      return this.gpuRenderer.renderWithEffects(activeDialogues, time);
    } else {
      return this.renderBasic(activeDialogues);
    }
  }
  
  private renderBasic(dialogues: ASSDialogue[]): ImageBitmap {
    // Canvas 2D 渲染简单样式
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    // ... 绘制文字、边框、阴影
    return canvas.transferToImageBitmap();
  }
}
```

### 流式 WASM 加载 (utils/streaming-wasm.ts)
```typescript
export async function loadStreamingWasm(url: string) {
  const response = await fetch(url);
  
  // 边下载边编译，无需等待完整文件
  const { module, instance } = await WebAssembly.instantiateStreaming(
    response,
    { env: { memory: new WebAssembly.Memory({ initial: 256 }) } }
  );
  
  return instance;
}
```

---

## 构建配置 (vite.config.ts)

```typescript
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { splitVendorChunkPlugin } from 'vite';

export default defineConfig({
  plugins: [solid(), splitVendorChunkPlugin()],
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: {
          // 核心分离
          'core': ['./src/core/player.ts'],
          // 解码器按需加载
          'decoders': ['./src/decode/codec-loader.ts'],
          // 字幕引擎
          'subtitles': ['./src/subtitle/ass-renderer.ts'],
          // FFmpeg 单独 chunk
          'ffmpeg': ['@ffmpeg/ffmpeg']
        }
      }
    },
    // 优化 WASM 处理
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg'] // 不预构建，手动控制加载
  }
});
```

---

## 性能指标目标

| 指标 | 目标值 |
|------|--------|
| 首屏加载 | < 300KB, < 1s (4G) |
| 首帧时间 (MP4) | < 200ms |
| 内存占用 | < 500MB (1080p) |
| ASS 特效帧率 | > 30fps |
| 软解 1080p | 流畅 (30fps+) |

---

## 开发路线图

1. **Phase 1**: 基础播放 (MP4 + WebCodecs + WebGPU)
2. **Phase 2**: 格式扩展 (MKV + 软解模块)
3. **Phase 3**: 字幕系统 (ASS基础 + PGS)
4. **Phase 4**: 高级特效 (ASS GPU渲染 + HDR)
5. **Phase 5**: FFmpeg集成 (全格式后备)

---

## 参考资源

- [WebGPU Spec](https://gpuweb.github.io/gpuweb/)
- [WebCodecs API](https://w3c.github.io/webcodecs/)
- [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)
- [SolidJS Docs](https://www.solidjs.com/)
- [ASS 格式规范](http://www.tcax.org/docs/ass-specs.htm)
