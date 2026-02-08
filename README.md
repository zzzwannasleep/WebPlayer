# WebPlayer

基于 SolidJS + Tailwind 的 Web 视频播放器实验项目，目标是逐步落地 “WebAssembly FFmpeg + WebGPU” 的全格式方案。

当前已包含：
- Vite + SolidJS + Tailwind 脚手架
- WebGPU 渲染（`texture_external` 采样）+ Canvas 2D 回退
- Phase 1 基线：MP4 + WebCodecs（仅视频）尝试；失败时回退到隐藏 `<video>` 解码并渲染到 canvas

## 开发

```bash
npm install
npm run dev
```

## 文档

- 技术方案：`docs/TECH_PLAN.md`

