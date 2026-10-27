import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, mkdir, copyFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import * as OpenCC from "opencc-js";
import { applyCorrections } from "./prompts.mjs";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

// whisper-small 即使加了简体提示，仍可能漏出少量繁体字，这里兜底转换。
const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });

const isAsciiPath = (p) => /^[\x20-\x7E]+$/.test(String(p || ""));

/**
 * whisper.cpp 在 Windows 上以窄字符 fopen 打开文件，模型放在中文路径下会直接加载失败。
 * 这里把模型镜像到纯 ASCII 目录（只做一次），彻底规避该问题。
 */
async function asciiSafeModelPath(modelPath) {
  if (isAsciiPath(modelPath)) return { path: modelPath, mirrored: false };

  const base = [process.env.LOCALAPPDATA, process.env.APPDATA, "C:\\ProgramData", tmpdir()].find(
    (candidate) => candidate && isAsciiPath(candidate),
  );
  if (!base) return { path: modelPath, mirrored: false };

  const dir = join(base, "lapian-studio", "models");
  await mkdir(dir, { recursive: true });
  const target = join(dir, basename(modelPath));

  try {
    const [source, cached] = await Promise.all([stat(modelPath), stat(target)]);
    if (source.size === cached.size) return { path: target, mirrored: true };
  } catch {
    /* 需要复制 */
  }

  await copyFile(modelPath, target);
  return { path: target, mirrored: true };
}

export function whisperBinDir(vendorDir) {
  return resolve(vendorDir, "whispercpp", "bin", `${process.platform}-${process.arch}`);
}

export function whisperModelDir(vendorDir) {
  return resolve(vendorDir, "whispercpp", "models");
}

export function whisperStatus(vendorDir, modelFile = "ggml-small.bin") {
  const exe = join(whisperBinDir(vendorDir), process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
  const model = join(whisperModelDir(vendorDir), modelFile);
  return {
    ready: existsSync(exe) && existsSync(model),
    executable: exe,
    executableExists: existsSync(exe),
    model,
    modelExists: existsSync(model),
    binDir: whisperBinDir(vendorDir),
  };
}

function runProcess(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\n[超时] 进程在 ${Math.round(timeoutMs / 1000)} 秒后被终止`;
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: stderr + String(error.message || error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function normalizeSegments(payload) {
  const list = Array.isArray(payload?.transcription)
    ? payload.transcription
    : Array.isArray(payload?.segments)
      ? payload.segments
      : [];

  return list
    .map((item) => {
      const fromMs = Number(item?.offsets?.from);
      const toMs = Number(item?.offsets?.to);
      const start = Number.isFinite(fromMs) ? fromMs / 1000 : Number(item?.start) || 0;
      const end = Number.isFinite(toMs) ? toMs / 1000 : Number(item?.end) || start;
      const text = toSimplified(String(item?.text ?? item?.content ?? "").trim());
      return { start, end, text };
    })
    .filter((item) => item.text);
}

function languageFor(dialectMode = "auto") {
  const map = {
    auto: "auto",
    mandarin: "zh",
    cantonese: "yue",
    sichuan: "zh",
    northeast: "zh",
    english: "en",
  };
  return map[String(dialectMode || "auto").toLowerCase()] || "auto";
}

/**
 * 用本地 whisper.cpp 转写视频。
 * @returns {Promise<{segments:Array, text:string, model:string}>}
 */
export async function transcribeLocal({
  buffer,
  fileName = "video.mp4",
  dialectMode = "auto",
  prompt = "",
  vendorDir,
  modelFile = "ggml-small.bin",
  threads,
  corrections = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const status = whisperStatus(vendorDir, modelFile);
  if (!status.ready) {
    const missing = [
      !status.executableExists ? `可执行文件缺失：${status.executable}` : "",
      !status.modelExists ? `模型缺失：${status.model}` : "",
    ]
      .filter(Boolean)
      .join("；");
    throw new Error(`本地转写引擎未就绪。${missing}`);
  }

  const safeModel = await asciiSafeModelPath(status.model);
  const workDir = await mkdtemp(join(tmpdir(), "lapian-transcribe-"));
  const ext = extname(fileName) || ".mp4";
  const inputPath = join(workDir, `input${ext}`);
  const outputPrefix = join(workDir, "result");

  try {
    await writeFile(inputPath, buffer);
    const cpu = (await import("node:os")).cpus?.()?.length || 4;
    const args = [
      "-m",
      safeModel.path,
      "-f",
      inputPath,
      "-l",
      languageFor(dialectMode),
      "-oj",
      "-of",
      outputPrefix,
      "-t",
      String(threads || Math.max(2, Math.min(cpu, 8))),
    ];
    if (prompt) args.push("--prompt", prompt);

    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") || "PATH";
    const result = await runProcess(status.executable, args, {
      cwd: status.binDir,
      env: {
        ...process.env,
        [pathKey]: `${status.binDir};${process.env[pathKey] || ""}`,
      },
      timeoutMs,
    });

    if (!result.ok) {
      const detail = (result.stderr || result.stdout || `退出码 ${result.code}`).trim().slice(-800);
      throw new Error(`本地转写失败：${detail}`);
    }

    const raw = await readFile(`${outputPrefix}.json`, "utf8").catch(() => "");
    if (!raw) throw new Error("本地转写未生成结果文件");
    const segments = normalizeSegments(JSON.parse(raw)).map((item) => ({
      ...item,
      text: applyCorrections(item.text, corrections),
    }));
    if (!segments.length) throw new Error("本地转写没有识别到有效口播");

    return {
      segments,
      text: segments.map((s) => s.text).join(""),
      model: `whisper.cpp/${modelFile}`,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function ensureDirs(vendorDir) {
  await mkdir(whisperModelDir(vendorDir), { recursive: true });
}
