# WebPlayer

基于 SolidJS + Tailwind 的 Web 视频播放器实验项目，目标是逐步落地「WebAssembly FFmpeg + WebGPU」的全格式方案。

当前已包含：
- Vite + SolidJS + Tailwind 脚手架
- WebGPU 渲染（`texture_external` 采样）+ Canvas 2D 回退
- WebCodecs 播放管线：MP4 / MKV / MPEG-TS（最小解封装）→ VideoDecoder +（可选）AudioDecoder + WebAudio 同步
- ASS/SSA 字幕：加载文件 + 简单文本 overlay（后续可扩展为 GPU 特效渲染）

容器/编码支持（当前最小版本）：
- MP4：依赖浏览器 WebCodecs 支持（常见 H.264 + AAC 可用）
- MKV：`V_MPEG4/ISO/AVC` + `A_AAC`
- TS/M2TS：H.264（stream_type `0x1B`）+ AAC（`0x0F`）

如果解封装或 WebCodecs 不支持，会回退到隐藏的 `<video>` 解码，并渲染到 canvas。

## 开发

```bash
npm install
npm run dev
```

## 文档

- 技术方案：`docs/TECH_PLAN.md`

