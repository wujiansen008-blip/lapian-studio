import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, normalize, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { transcribeLocal, whisperStatus } from "./transcribe.mjs";
import { buildTranscribePrompt } from "./prompts.mjs";
import { testConnection } from "./ai.mjs";
import { runAnalyze, runReview, runFinalCompare, runFission } from "./tasks.mjs";
import {
  ffmpegPath,
  ffmpegStatus,
  registerSourceStream,
  sourcePathById,
  cutClip,
  clipCachePath,
  exportShots,
} from "./media.mjs";
import { saveRecord, listRecords, getRecord, updateRecordCategory, updateRecordNotes, imagePath, deleteRecord } from "./history.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const DEFAULT_SETTINGS = {
  baseUrl: "https://api.openai.com",
  apiKey: "",
  model: "",
  visionModel: "",
  // 视觉模型可以来自另一家服务商（如 DeepSeek 主文本 + 通义千问 VL 看画面）
  visionBaseUrl: "",
  visionApiKey: "",
  transcribeModel: "ggml-small.bin",
  dialectMode: "auto",
  productHint: "",
  audienceHint: "",
  // 行业术语表：留空则不注入；填了会显著提升专名识别率
  glossary: [],
  // 二维数组 [[错词, 正确写法], ...]；留空则使用内置默认纠错表
  corrections: [],
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limitBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error(`请求体超过上限 ${Math.round(limitBytes / 1024 / 1024)}MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, limitBytes) {
  const raw = await readBody(req, limitBytes);
  if (!raw.length) return {};
  return JSON.parse(raw.toString("utf8"));
}

function decodeHeader(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

export async function startServer({ port = 5178, dataDir, vendorDir, webDir } = {}) {
  if (!dataDir) throw new Error("startServer 需要 dataDir");
  const settingsPath = join(dataDir, "settings.json");
  // 团队预置配置：随安装包分发，首次启动时写入，之后以用户自己的配置为准
  const seedPath = join(dirname(fileURLToPath(import.meta.url)), "seed-settings.json");
  await mkdir(dataDir, { recursive: true });

  const loadSettings = async () => {
    try {
      const raw = await readFile(settingsPath, "utf8");
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      // 首次运行：拿预置配置初始化，目标用户开箱即用
      try {
        const seed = JSON.parse(await readFile(seedPath, "utf8"));
        const merged = { ...DEFAULT_SETTINGS, ...seed };
        await writeFile(settingsPath, JSON.stringify(merged, null, 2), "utf8");
        return merged;
      } catch {
        return { ...DEFAULT_SETTINGS };
      }
    }
  };

  const saveSettings = async (patch) => {
    const current = await loadSettings();
    const next = { ...current, ...patch };
    await writeFile(settingsPath, JSON.stringify(next, null, 2), "utf8");
    return next;
  };

  const publicSettings = (s) => {
    const key = String(s.apiKey || "");
    return {
      ...s,
      apiKey: "",
      apiKeySet: Boolean(key),
      apiKeyHint: key ? `${key.slice(0, 4)}****${key.slice(-4)}` : "",
    };
  };

  const resolveConfig = async (useVision = false) => {
    const s = await loadSettings();
    // 视觉任务如果单独配了服务商，就完全走视觉那套（baseUrl + key + model）
    if (useVision && s.visionBaseUrl && s.visionApiKey) {
      return {
        baseUrl: s.visionBaseUrl,
        apiKey: s.visionApiKey,
        model: s.visionModel || s.model,
      };
    }
    return {
      baseUrl: s.baseUrl,
      apiKey: s.apiKey,
      model: useVision ? s.visionModel || s.model : s.model,
    };
  };

  const handler = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const path = url.pathname;

    try {
      if (req.method === "GET" && path === "/api/health") {
        const s = await loadSettings();
        json(res, 200, {
          ok: true,
          whisper: whisperStatus(vendorDir, s.transcribeModel),
          ffmpeg: ffmpegStatus(vendorDir),
          settings: publicSettings(s),
        });
        return;
      }

      if (req.method === "GET" && path === "/api/settings") {
        json(res, 200, { ok: true, settings: publicSettings(await loadSettings()) });
        return;
      }

      if (req.method === "POST" && path === "/api/settings") {
        const patch = await readJson(req, 1024 * 1024);
        if (patch.apiKey === "") delete patch.apiKey;
        const next = await saveSettings(patch);
        json(res, 200, { ok: true, settings: publicSettings(next) });
        return;
      }

      if (req.method === "POST" && path === "/api/ai/test") {
        const config = await resolveConfig();
        const result = await testConnection(config);
        json(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && path === "/api/media/source") {
        const fileName = decodeHeader(req.headers["x-file-name"]) || "source.mp4";
        const result = await registerSourceStream(req, fileName, dataDir);
        json(res, 200, { ok: true, sourceId: result.sourceId, size: result.size, name: result.name });
        return;
      }

      if (req.method === "POST" && path === "/api/media/clip") {
        const payload = await readJson(req, 1024 * 1024);
        const sourcePath = sourcePathById(dataDir, payload.sourceId);
        const cachePath = clipCachePath(dataDir, payload.sourceId, payload.start, payload.end);
        if (!existsSync(cachePath) || statSync(cachePath).size === 0) {
          await cutClip({
            ffmpeg: ffmpegPath(vendorDir),
            sourcePath,
            start: payload.start,
            end: payload.end,
            outputPath: cachePath,
          });
        }
        const clipSize = statSync(cachePath).size;
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": clipSize,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(payload.fileName || "clip.mp4")}`,
          "Cache-Control": "private, max-age=86400",
        });
        createReadStream(cachePath).pipe(res);
        return;
      }

      // 供 <video> 直接播放：GET + Range 支持（POST 无法作为 video src）
      if (req.method === "GET" && path === "/api/media/clip-stream") {
        const sourceId = String(url.searchParams.get("sourceId") || "");
        const start = Number(url.searchParams.get("start") || 0);
        const end = Number(url.searchParams.get("end") || 0);
        if (!sourceId) throw new Error("缺少 sourceId");
        if (!(end > start)) throw new Error("时间区间无效");

        const cachePath = clipCachePath(dataDir, sourceId, start, end);
        if (!existsSync(cachePath) || statSync(cachePath).size === 0) {
          await cutClip({
            ffmpeg: ffmpegPath(vendorDir),
            sourcePath: sourcePathById(dataDir, sourceId),
            start,
            end,
            outputPath: cachePath,
          });
        }

        const total = statSync(cachePath).size;
        const range = req.headers.range;
        if (range) {
          const match = /bytes=(\d*)-(\d*)/.exec(range);
          const from = match && match[1] ? Number(match[1]) : 0;
          const to = match && match[2] ? Number(match[2]) : total - 1;
          const endByte = Math.min(to, total - 1);
          if (from >= total) {
            res.writeHead(416, { "Content-Range": `bytes */${total}` });
            res.end();
            return;
          }
          res.writeHead(206, {
            "Content-Type": "video/mp4",
            "Content-Range": `bytes ${from}-${endByte}/${total}`,
            "Accept-Ranges": "bytes",
            "Content-Length": endByte - from + 1,
            "Cache-Control": "private, max-age=86400",
          });
          createReadStream(cachePath, { start: from, end: endByte }).pipe(res);
          return;
        }

        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": total,
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, max-age=86400",
        });
        createReadStream(cachePath).pipe(res);
        return;
      }

      if (req.method === "POST" && path === "/api/media/export") {
        const payload = await readJson(req, 4 * 1024 * 1024);
        const directory = String(payload.directory || "");
        if (!directory || !existsSync(directory)) throw new Error("导出目录不存在，请重新选择");
        const sourcePath = sourcePathById(dataDir, payload.sourceId);
        const shots = Array.isArray(payload.shots) ? payload.shots : [];
        if (!shots.length) throw new Error("没有可导出的分镜，请先完成拉片");
        const results = await exportShots({
          ffmpeg: ffmpegPath(vendorDir),
          sourcePath,
          directory,
          shots,
          prefix: payload.prefix || "S",
        });
        json(res, 200, {
          ok: true,
          results,
          total: results.length,
          failed: results.filter((item) => !item.ok).length,
        });
        return;
      }

      if (req.method === "POST" && path === "/api/transcribe") {
        const s = await loadSettings();
        const raw = await readBody(req, 600 * 1024 * 1024);
        const prompt = buildTranscribePrompt({
          productHint: decodeHeader(req.headers["x-product-hint"]) || s.productHint,
          audienceHint: decodeHeader(req.headers["x-audience-hint"]) || s.audienceHint,
          glossary: s.glossary,
        });
        const result = await transcribeLocal({
          buffer: raw,
          fileName: decodeHeader(req.headers["x-file-name"]) || "video.mp4",
          dialectMode: decodeHeader(req.headers["x-dialect"]) || s.dialectMode,
          prompt,
          vendorDir,
          modelFile: s.transcribeModel,
          corrections: s.corrections,
        });
        json(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && path === "/api/analyze") {
        const payload = await readJson(req, 200 * 1024 * 1024);
        const config = await resolveConfig(true);
        const result = await runAnalyze({ config, payload });
        json(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && path === "/api/review") {
        const payload = await readJson(req, 200 * 1024 * 1024);
        const config = await resolveConfig(true);
        const result = await runReview({ config, payload });
        json(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && path === "/api/fission") {
        const payload = await readJson(req, 200 * 1024 * 1024);
        const config = await resolveConfig();
        const result = await runFission({ config, payload });
        json(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && path === "/api/final-compare") {
        const payload = await readJson(req, 200 * 1024 * 1024);
        const config = await resolveConfig(true);
        const result = await runFinalCompare({ config, payload });
        json(res, 200, { ok: true, ...result });
        return;
      }

      if (path === "/api/history" && req.method === "GET") {
        json(res, 200, { ok: true, records: await listRecords(dataDir) });
        return;
      }

      if (path === "/api/history" && req.method === "POST") {
        const payload = await readJson(req, 300 * 1024 * 1024);
        const summary = await saveRecord(dataDir, payload);
        json(res, 200, { ok: true, record: summary });
        return;
      }

      const notesMatch = path.match(/^\/api\/history\/([a-z0-9-]{8,64})\/notes$/i);
      if (notesMatch && req.method === "POST") {
        const payload = await readJson(req, 512 * 1024);
        const result = await updateRecordNotes(dataDir, notesMatch[1], payload.notes);
        json(res, 200, { ok: true, ...result });
        return;
      }

      const categoryMatch = path.match(/^\/api\/history\/([a-z0-9-]{8,64})\/category$/i);
      if (categoryMatch && req.method === "POST") {
        const payload = await readJson(req, 64 * 1024);
        const summary = await updateRecordCategory(dataDir, categoryMatch[1], payload.category);
        json(res, 200, { ok: true, record: summary });
        return;
      }

      const historyMatch = path.match(/^\/api\/history\/([a-z0-9-]{8,64})(?:\/img\/([^/]+))?$/i);
      if (historyMatch) {
        const recordId = historyMatch[1];
        const imgName = historyMatch[2] ? decodeURIComponent(historyMatch[2]) : "";
        if (imgName && req.method === "GET") {
          const file = await imagePath(dataDir, recordId, imgName);
          const imgSize = statSync(file).size;
          res.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Content-Length": imgSize,
            "Cache-Control": "private, max-age=86400",
          });
          createReadStream(file).pipe(res);
          return;
        }
        if (req.method === "GET") {
          json(res, 200, { ok: true, record: await getRecord(dataDir, recordId) });
          return;
        }
        if (req.method === "DELETE") {
          json(res, 200, { ok: true, ...(await deleteRecord(dataDir, recordId)) });
          return;
        }
      }

      if (path.startsWith("/api/")) {
        json(res, 404, { ok: false, error: `未知接口 ${path}` });
        return;
      }

      if (!webDir || !existsSync(webDir)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("前端未构建。开发模式请访问 Vite 端口。");
        return;
      }

      const rel = path === "/" ? "/index.html" : path;
      const target = normalize(join(webDir, rel));
      if (!target.startsWith(normalize(webDir))) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      let filePath = target;
      try {
        const info = await stat(filePath);
        if (info.isDirectory()) filePath = join(filePath, "index.html");
      } catch {
        filePath = join(webDir, "index.html");
      }

      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
      createReadStream(filePath).pipe(res);
    } catch (error) {
      json(res, 500, { ok: false, error: error?.message || String(error) });
    }
  };

  const server = createServer(handler);

  const probePort = (p) =>
    new Promise((resolve) => {
      const tester = createNetServer();
      tester.once("error", () => resolve(false));
      tester.once("listening", () => tester.close(() => resolve(true)));
      tester.listen(p, "127.0.0.1");
    });

  let actualPort = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await probePort(port + attempt)) {
      actualPort = port + attempt;
      break;
    }
  }
  if (!actualPort) throw new Error(`端口 ${port}-${port + 9} 都被占用，无法启动本地服务`);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(actualPort, "127.0.0.1", resolve);
  });

  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
