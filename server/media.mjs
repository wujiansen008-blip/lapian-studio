import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join, extname, resolve, basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024;

/** 优先用内置 ffmpeg，其次环境变量，最后系统 PATH。 */
export function ffmpegPath(vendorDir) {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const bundled = resolve(vendorDir, "ffmpeg", `${process.platform}-${process.arch}`, exe);
  if (existsSync(bundled)) return bundled;
  const configured = String(process.env.FFMPEG_PATH || "").trim();
  if (configured && existsSync(configured)) return configured;
  return "ffmpeg";
}

export function ffmpegStatus(vendorDir) {
  const path = ffmpegPath(vendorDir);
  return {
    ready: path !== "ffmpeg" || Boolean(process.env.FFMPEG_PATH),
    path,
    bundled: path !== "ffmpeg",
  };
}

function sourceDir(dataDir) {
  return join(dataDir, "media-cache", "sources");
}

function clipDir(dataDir) {
  return join(dataDir, "media-cache", "clips");
}

/** 把上传的原始视频落到本地缓存，按内容 SHA256 命名，重复上传直接复用。 */
export async function registerSourceStream(readable, fileName, dataDir) {
  const directory = sourceDir(dataDir);
  await mkdir(directory, { recursive: true });

  const rawName = String(fileName || "source.mp4");
  const extension = /^\.[a-z0-9]{1,8}$/i.test(extname(rawName)) ? extname(rawName).toLowerCase() : ".mp4";
  const temporaryPath = join(directory, `.upload-${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`);

  const hash = createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_SOURCE_BYTES) {
        callback(new Error("视频超过 2GB，无法处理"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(readable, meter, createWriteStream(temporaryPath));
    if (!size) throw new Error("视频内容为空");
    const sourceId = `${hash.digest("hex")}${extension}`;
    const finalPath = join(directory, sourceId);
    if (existsSync(finalPath)) await rm(temporaryPath, { force: true });
    else await rename(temporaryPath, finalPath);
    return { sourceId, name: rawName, size, path: finalPath };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function sourcePathById(dataDir, sourceId) {
  const safe = String(sourceId || "").toLowerCase();
  if (!/^[a-f0-9]{64}\.[a-z0-9]{1,8}$/.test(safe)) throw new Error("源视频标识无效，请重新上传");
  const path = join(sourceDir(dataDir), safe);
  if (!existsSync(path)) throw new Error("本地源视频缓存已失效，请重新上传");
  return path;
}

function runFfmpeg(ffmpeg, args, timeoutMs = 300000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ffmpeg 超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `ffmpeg 退出码 ${code}`));
    });
  });
}

/** 精确切一段，输出 h264 + aac 的 mp4。 */
export async function cutClip({ ffmpeg, sourcePath, start, end, outputPath }) {
  const from = Number(start);
  const to = Number(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error("分镜区间无效");
  if (to - from > 30 * 60) throw new Error("单个分镜不能超过 30 分钟");

  await mkdir(join(outputPath, ".."), { recursive: true });
  const temporaryPath = `${outputPath}.${Math.random().toString(16).slice(2)}.tmp.mp4`;

  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", sourcePath,
    "-ss", from.toFixed(3),
    "-t", (to - from).toFixed(3),
    "-map", "0:v:0",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "160k",
    "-movflags", "+faststart",
    temporaryPath,
  ];

  try {
    await runFfmpeg(ffmpeg, args);
    if (!existsSync(temporaryPath) || !statSync(temporaryPath).size) throw new Error("切片结果为空");
    if (existsSync(outputPath) && statSync(outputPath).size > 0) await rm(temporaryPath, { force: true });
    else await rename(temporaryPath, outputPath);
    return outputPath;
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function stamp(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 1000);
  return `${String(m).padStart(2, "0")}m${String(sec).padStart(2, "0")}s${String(ms).padStart(3, "0")}`;
}

export function clipFileName(shot, prefix = "S") {
  const index = String((Number(shot.index) || 0) + 1).padStart(2, "0");
  const safePrefix = String(prefix || "S").replace(/[\\/:*?"<>|]/g, "_");
  return `${safePrefix}${index}_${stamp(shot.start)}-${stamp(shot.end)}.mp4`;
}

/** 缓存路径（单镜下载复用）。 */
export function clipCachePath(dataDir, sourceId, start, end) {
  const key = createHash("sha256").update(`${sourceId}|${Number(start).toFixed(3)}|${Number(end).toFixed(3)}|h264-aac-v1`).digest("hex");
  return join(clipDir(dataDir), `${key}.mp4`);
}

/** 批量导出到用户指定目录。 */
export async function exportShots({ ffmpeg, sourcePath, directory, shots, prefix = "S", onProgress }) {
  const results = [];
  for (const [i, shot] of shots.entries()) {
    const name = clipFileName(shot, prefix);
    const outputPath = join(directory, name);
    try {
      if (!(existsSync(outputPath) && statSync(outputPath).size > 0)) {
        await cutClip({ ffmpeg, sourcePath, start: shot.start, end: shot.end, outputPath });
      }
      results.push({ index: shot.index, name, ok: true });
    } catch (error) {
      results.push({ index: shot.index, name, ok: false, error: error?.message || String(error) });
    }
    onProgress?.(i + 1, shots.length, name);
  }
  return results;
}

export async function ensureDirs(dataDir) {
  await mkdir(sourceDir(dataDir), { recursive: true });
  await mkdir(clipDir(dataDir), { recursive: true });
}

export function sourceName(fileName) {
  return basename(String(fileName || "source.mp4"));
}
