import { createWorker } from "tesseract.js";

/**
 * 画面字幕 OCR。
 * 做法：按固定间隔跳帧 → 裁画面下方区域 → 逐帧识别 → 合并成时间段。
 * 只取下方是因为口播字幕几乎都在底部，全画面识别会引入大量背景噪声。
 */

const LANG_CDN = "https://tessdata.projectnaptha.com/4.0.0";
const LANG_LOCAL = "/tesseract";

let workerPromise = null;
let statusListener = null;

/** 优先用随包发布的本地语言包，缺失时才联网下载。 */
async function resolveLangPath() {
  try {
    const res = await fetch(`${LANG_LOCAL}/chi_sim.traineddata.gz`, { method: "HEAD" });
    if (res.ok) return LANG_LOCAL;
  } catch {
    /* 本地没有就走 CDN */
  }
  return LANG_CDN;
}

function waitForSeek(video, time) {
  return new Promise((resolve, reject) => {
    const target = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.05));
    if (Math.abs(video.currentTime - target) < 0.02) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("跳帧超时"));
    }, 6000);
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = target;
  });
}

function cleanText(raw) {
  return String(raw || "")
    .replace(/\s+/g, "")
    .replace(/[^[\u4e00-\u9fa5a-zA-Z0-9，。！？、：；""''（）()%+\-]/g, "")
    .trim();
}

function sameSentence(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 4 && longer.includes(shorter)) return true;
  // 长度接近时允许 1-2 字差异（OCR 抖动）
  if (Math.abs(a.length - b.length) <= 2) {
    let diff = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i += 1) {
      if (a[i] !== b[i]) diff += 1;
      if (diff > 2) return false;
    }
    return diff <= 2;
  }
  return false;
}

async function getWorker() {
  if (!workerPromise) {
    const langPath = await resolveLangPath();
    workerPromise = createWorker("chi_sim", 1, {
      langPath,
      gzip: true,
      logger: (message) => {
        // 语言包下载/初始化阶段给前端一个明确反馈，避免看起来卡死
        if (message?.status) statusListener?.(message.status, Math.round((message.progress || 0) * 100));
      },
      errorHandler: (err) => console.warn("[ocr]", err),
    }).catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

export async function releaseOcrWorker() {
  if (!workerPromise) return;
  try {
    const worker = await workerPromise;
    await worker.terminate();
  } catch {
    /* 已在异常态，忽略 */
  }
  workerPromise = null;
}

/**
 * @param {HTMLVideoElement} video 已经加载好源视频的 video 元素
 * @param {object} options
 * @param {number} options.interval 抽帧间隔（秒）
 * @param {number} options.bottomRatio 只识别画面下方多大比例
 * @param {(ratio:number, text:string)=>void} options.onProgress
 * @returns {Promise<Array<{start:number,end:number,text:string}>>}
 */
export async function ocrSubtitles(video, { interval = 0.6, bottomRatio = 0.42, onProgress, onStatus } = {}) {
  const duration = Number(video?.duration) || 0;
  if (!duration) throw new Error("视频还没加载好，无法识别字幕");
  const videoWidth = video.videoWidth || 720;
  const videoHeight = video.videoHeight || 1280;

  const width = Math.min(720, videoWidth);
  const height = Math.round(width * (videoHeight / videoWidth));
  const cropTop = Math.round(height * (1 - bottomRatio));
  const cropHeight = height - cropTop;

  const full = document.createElement("canvas");
  full.width = width;
  full.height = height;
  const fullCtx = full.getContext("2d", { alpha: false });

  const crop = document.createElement("canvas");
  crop.width = width;
  crop.height = cropHeight;
  const cropCtx = crop.getContext("2d", { alpha: false });

  statusListener = onStatus || null;
  const worker = await getWorker();
  const samples = [];
  const origin = video.currentTime;

  try {
    for (let time = 0; time < duration; time += interval) {
      await waitForSeek(video, time);
      fullCtx.fillStyle = "#000000";
      fullCtx.fillRect(0, 0, width, height);
      fullCtx.drawImage(video, 0, 0, width, height);
      cropCtx.drawImage(full, 0, cropTop, width, cropHeight, 0, 0, width, cropHeight);

      const { data } = await worker.recognize(crop);
      const text = cleanText(data.text);
      const confident = Number(data.confidence) >= 45 && text.length >= 2;
      samples.push({ time, text: confident ? text : "" });
      onProgress?.(Math.min(1, (time + interval) / duration), confident ? text : "");
    }
  } finally {
    statusListener = null;
    video.currentTime = origin;
  }

  // 合并连续相同文本为时间段
  const segments = [];
  let current = null;
  for (const sample of samples) {
    if (!sample.text) continue;
    if (current && sameSentence(current.text, sample.text)) {
      current.end = Number((sample.time + interval).toFixed(2));
      if (sample.text.length > current.text.length) current.text = sample.text;
    } else {
      if (current) segments.push(current);
      current = {
        start: Number(sample.time.toFixed(2)),
        end: Number((sample.time + interval).toFixed(2)),
        text: sample.text,
      };
    }
  }
  if (current) segments.push(current);
  return segments;
}
