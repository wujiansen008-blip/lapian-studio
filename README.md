# 拉片工作台（lapian-studio）

短视频爆款拉片桌面工具。本地转写 + 分镜视觉核对 + 结构化拉片报告。

## 它做什么

三个工作模式，顶栏切换：

**① 拉片分析** — 上传一条素材，得到可执行的拉片报告：
- **口播转写**：本地 whisper.cpp，免费、不出网
- **分镜核对**：等分抽帧 → 拼成联系表 → 视觉模型逐格描述画面
- **方法论拆解**：内容三层分类、21 式黄金 3 秒、六线脚本法、情绪曲线

**② 投放复盘** — 上传四张千川后台截图（数据总览 / 点赞 / 流失 / 点击），
结合拉片结论判断该继续投、优化后再投还是停投，并给出带时间点的修改动作。

**③ 终局对比** — 上传对标视频 + 成品视频，左右配对逐镜比较，
13 项维度打分，输出「差在哪一秒、怎么改、验收标准是什么」。

**④ 逐镜裂变** — 把拉片结果转成槽位矩阵，一条爆款裂变出 N 条变体：
每个分镜产出 3 条口播、3-5 条画面、2-3 条字幕，附组合规则（顺序锁定 / 随机允许 / 绑定 / 禁混）与验证指标。

## 技术结构

```
electron/main.cjs      主进程，启动本地服务并加载界面
server/index.mjs       本地 HTTP 服务（127.0.0.1:5178）
server/tasks.mjs       三个 AI 任务（拉片分析 / 投放复盘 / 终局对比）
server/prompts.mjs     方法论提示词（可直接修改）
server/ai.mjs          OpenAI 兼容调用层，任意供应商可换
server/transcribe.mjs  whisper.cpp 调用
src/App.vue            界面
src/lib/frames.js      抽帧 + 联系表拼图（纯 Canvas，不依赖 ffmpeg）
src/lib/localAnalysis.js  本地规则引擎（零成本初判）
```

## 快速开始

```bash
npm install
npm run dev            # 终端 A：启动前端
npm run electron:dev   # 终端 B：启动桌面壳
```

打包：

```bash
npm run dist
```

## 必须先做的两件配置

1. **转写引擎**：把 whisper.cpp 的 `whisper-cli.exe` 与依赖 dll 放到
   `vendor/whispercpp/bin/win32-x64/`，模型放到 `vendor/whispercpp/models/ggml-small.bin`。
2. **模型 API**：在设置里填 Base URL + API Key + 模型名。必须选**支持视觉**的模型
   （拉片分析要读分镜图）。OpenAI 兼容接口均可：OpenAI、豆包、通义、智谱、硅基流动、自建中转。

## 分镜导出

拉片完成后，左栏「分镜导出」可把每个分镜按区间切成独立 mp4（内置 ffmpeg，h264/aac），
选一个目录即可批量导出，文件名形如 `S01_00m00s000-00m03s000.mp4`，直接交给剪辑师。

源视频会在上传时按 SHA256 缓存到 `%APPDATA%\lapian-studio\media-cache\sources\`，
同一个文件重复上传不会重复占空间。ffmpeg 位于 `vendor/ffmpeg/win32-x64/ffmpeg.exe`。

## 成本说明

- 抽帧、拼图、转写、本地初判、分镜切片：全部本地，零成本
- 只有 AI 拉片 / 复盘 / 对比 / 裂变会产生模型费用
  （拉片一次约 1~3 张联系表 + 8k 输出 token；裂变输出上限 16k token，耗时 2-4 分钟）

## 文档

- `docs/01-逆向技术规格.md`：完整工艺参数与输出 schema
- `docs/02-0.1.18差异与补齐.md`：与原版最新版的差异盘点、已补/未补清单
- `docs/prompts/`：方法论提示词说明
- `server/prompts-core.mjs`：四套提示词逐字原文（自动提取）

## 边界

本项目的业务逻辑参考自对某商业软件的静态分析，**代码全部重写**，不含其源码、图标、品牌与授权计费体系。
`whisper.cpp` 与 ggml 模型为 MIT 许可，可自由使用。
