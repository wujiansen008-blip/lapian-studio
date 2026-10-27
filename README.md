# 拉片工作台

短视频爆款拉片工具。上传一条竞品视频，自动完成抽帧、转写、AI 拉片分析、投放复盘、成品对比、逐镜裂变，并把结果导出成图、CSV 或分镜视频片段。

基于 Electron + Vue 3，全部数据留在本地（`%APPDATA%\lapian-studio`），只有调用大模型时才会联网。

## 六个页面

| 页面 | 作用 |
|---|---|
| 拉片分析 | 14 项脚本总结 + 4 维画面总结 + 六线脚本 + 分镜六件套 + 剪映脚本 |
| 分镜拉片 | 横向矩阵，每格是**可播放的分镜视频**，不是静帧 |
| 投放复盘 | 4 张投放截图 → 指引消耗 / 峰值流失 / 下步动作 |
| 终局对比 | 固定 4 段（开头钩子 / 卖点铺垫 / 信任补强 / 结尾转化）对标 vs 成品 |
| 逐镜裂变 | 10 字段产品资料 → 每镜 3 条口播 + 3-5 条画面 |
| 历史记录 | 自动存档，支持全选导出 CSV（可直接导入飞书表格） |

## 安装

下载 `拉片工作台 Setup x.x.x.exe`（约 115MB）安装，然后**手动放一次语音模型**：

1. 打开应用 → 左栏「流水线」卡片会提示「语音模型未安装」
2. 点 **打开模型目录**，会自动打开并创建该目录：
   ```
   安装目录\resources\vendor\whispercpp\models\
   ```
3. 把 `ggml-small.bin`（约 466MB）放进去，重启应用

模型下载：https://huggingface.co/ggerganov/whisper.cpp/tree/main （选 `ggml-small.bin`）

**为什么模型不放进安装包**：它有 466MB，会让安装包从 115MB 膨胀到 530MB，且以后每次更新都得重下。现在模型装一次永久复用，安装包保持轻量。

**不装模型也能用**：抽帧、AI 拉片分析、终局对比、逐镜裂变、导出全部正常，只是没有口播文本，报告里的「三段论」「口播文案」会缺内容。

## 模型配置

设置面板里分**两组**，这点很重要：

**文本模型** — 用于逐镜裂变的文案生成，便宜的模型就够
```
Base URL   https://api.deepseek.com
模型       deepseek-flash
```

**视觉模型** — 用于拉片分析 / 投放复盘 / 终局对比，**必须支持图片输入**
```
Base URL   https://dashscope.aliyuncs.com/compatible-mode/v1
模型       qwen3-vl-plus
```

视觉模型可以来自另一家服务商（填独立的 Key 即可）。

### 一个已经踩过的坑

**DeepSeek 的 API 不支持图片。** 收到图片后它会替换成 `[Unsupported Image]` 占位符，模型看不到画面，输出全是"待核对 / 无法判断"。拉片分析必须用支持视觉的模型：

- 阿里云百炼 `qwen3-vl-plus`（推荐，国内直连）
- 智谱 `glm-4v-plus`
- 豆包 Vision
- OpenAI `gpt-4o` / Claude（需代理）

判断一个 Key 属于哪家、能不能用视觉，直接请求 `/v1/models` 看返回码最准，别猜格式。

## 从源码运行

```bash
npm install
npm run dev          # 前端调试
npm run electron:dev # 桌面版（开发模式）
npm run start        # 构建 + 启动
```

打包：

```bash
npm run dist         # 生成安装包（dist/）
```

国内网络建议加镜像：

```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

## 数据位置

```
%APPDATA%\lapian-studio\
  settings.json      模型配置（含 API Key，注意不要提交）
  history\           拉片历史，每次分析自动存档
  media-cache\       源视频与切片缓存
```

## 已知限制

- **安装包不含语音模型**：首次安装需手动放 `ggml-small.bin`（见「安装」一节），界面会提示路径。
- **字幕 OCR** 代码已完成（`src/lib/ocr.js`），但中文语言包（约 20MB）需首次联网下载。离线部署：把 `chi_sim.traineddata.gz` 放进 `public/tesseract/` 后重新构建。
- **飞书双表写入**未实现，目前用 CSV 导出代替。
- 分镜视频播放依赖源视频缓存；缓存被清后历史记录只能看截图。
- 安装包未做代码签名，Windows 首次运行可能提示"未知发布者"。

## 技术栈

Electron 33 · Vue 3 · Vite 6 · ffmpeg（抽帧 / 切片）· whisper.cpp（本地转写）· tesseract.js（OCR）· html2canvas（报告导出）
