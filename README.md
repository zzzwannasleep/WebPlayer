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

如果解封装或 WebCodecs 不支持，会回退到 `<video>` 元素播放（直接显示）。

## 开发

```bash
npm install
npm run dev
```

## 文档

- 技术方案：`docs/TECH_PLAN.md`

## Demo（GitHub Pages）

1. 推送到 `main` 分支后，GitHub Actions 会执行构建并部署到 Pages：`.github/workflows/pages.yml`
2. 在仓库 Settings → Pages → **Build and deployment** 中选择 **Source: GitHub Actions**
3. 访问地址通常是：`https://<owner>.github.io/<repo>/`

## URL 播放（CORS / Range）

- MP4/WebM：WebCodecs 解封装失败时会自动回退到 `<video>` 直接播放（通常不需要 CORS）。
- MKV/TS：需要 `fetch` 读取字节流做解封装，目标服务器必须允许 CORS，并支持/暴露 Range 相关响应头（`Accept-Ranges` / `Content-Range` / `Content-Length` 等）。纯前端无法绕过 CORS。
- 如果你不控制视频源：需要你自己做反向代理/同源转发（本地 Nginx/Caddy/Vite dev server 等），或让源站开放 CORS + Range。
