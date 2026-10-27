<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";
import {
  extractFrames,
  buildContactSheets,
  buildPairedContactSheet,
  readVideoMeta,
  imageFileToDataUrl,
  formatTime,
} from "./lib/frames.js";
import { decodeAudioFromFile, makeAudioChunks, offsetSegments } from "./lib/audio.js";
import { buildLocalAnalysis } from "./lib/localAnalysis.js";
import { ocrSubtitles } from "./lib/ocr.js";
import html2canvas from "html2canvas";

const MODES = [
  { id: "lapian", label: "拉片分析" },
  { id: "storyboard", label: "分镜拉片" },
  { id: "review", label: "投放复盘" },
  { id: "compare", label: "终局对比" },
  { id: "fission", label: "逐镜裂变" },
  { id: "history", label: "历史记录" },
];

const SHOT_SLOTS = [
  { key: "overview", title: "投放数据总览" },
  { key: "likes", title: "整体点赞次数" },
  { key: "loss", title: "整体流失人数" },
  { key: "clicks", title: "整体点击次数" },
];

const mode = ref("lapian");

const videoEl = ref(null);
const finalVideoEl = ref(null);
const file = ref(null);
const finalFile = ref(null);
const videoUrl = ref("");
const finalVideoUrl = ref("");
const meta = ref({ duration: 0, width: 0, height: 0 });
const finalMeta = ref({ duration: 0, width: 0, height: 0 });
const shotCount = ref(9);
const productInput = ref("");
const audienceInput = ref("");

const frames = ref([]);
const finalFrames = ref([]);

/* ---------- 分镜大图预览 ---------- */
const lightbox = ref({ open: false, index: 0, source: "frames" });

const lightboxList = computed(() => (lightbox.value.source === "final" ? finalFrames.value : frames.value));
const lightboxFrame = computed(() => lightboxList.value[lightbox.value.index] || null);

const lightboxClipUrl = computed(() => {
  const frame = lightboxFrame.value;
  if (!frame || !sourceId.value || lightbox.value.source !== "frames") return "";
  const start = Number(frame.start) || 0;
  const end = Number(frame.end) || 0;
  if (!(end > start)) return "";
  return `/api/media/clip-stream?sourceId=${encodeURIComponent(sourceId.value)}&start=${start.toFixed(2)}&end=${end.toFixed(2)}`;
});

function openLightbox(index, source = "frames") {
  const list = source === "final" ? finalFrames.value : frames.value;
  if (!list[index]) return;
  lightbox.value = { open: true, index, source };
}

function closeLightbox() {
  lightbox.value = { open: false, index: 0, source: "frames" };
}

function stepLightbox(delta) {
  const total = lightboxList.value.length;
  if (total < 2) return;
  lightbox.value.index = (lightbox.value.index + delta + total) % total;
}

function onLightboxKey(event) {
  if (!lightbox.value.open) return;
  if (event.key === "Escape") closeLightbox();
  else if (event.key === "ArrowLeft") stepLightbox(-1);
  else if (event.key === "ArrowRight") stepLightbox(1);
}
const segments = ref([]);
const transcriptText = ref("");
const finalTranscript = ref("");
const analysis = ref(null);
const localAnalysis = ref(null);
const contactSheets = ref([]);
const sourceId = ref("");
const exporting = ref(false);
const exportInfo = ref(null);

const reviewSlots = ref({});
const review = ref(null);
const compare = ref(null);
const fission = ref(null);

const FISSION_PROFILE_KEY = "lapian:fission-profile";
const DEFAULT_FISSION_PROFILE = {
  productName: "",
  category: "",
  audience: "",
  goal: "综合提升",
  scene: "",
  pain: "",
  offer: "",
  forbidden: "",
  sellingPoints: "",
  proof: "",
};

function loadFissionProfile() {
  try {
    const raw = localStorage.getItem(FISSION_PROFILE_KEY);
    if (!raw) return { ...DEFAULT_FISSION_PROFILE };
    return { ...DEFAULT_FISSION_PROFILE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_FISSION_PROFILE };
  }
}

const fissionProfile = ref(loadFissionProfile());

watch(
  fissionProfile,
  (value) => {
    try {
      localStorage.setItem(FISSION_PROFILE_KEY, JSON.stringify(value));
    } catch {
      /* 配额或隐私模式失败时忽略，不影响本次使用 */
    }
  },
  { deep: true },
);

const historyRecords = ref([]);
const historyLoading = ref(false);

/* 项目分类：素材多了必须分类，否则历史列表没法用 */
const HISTORY_CATEGORIES = ["带货种草", "知识科普", "剧情类", "情感类", "其他", "未分类"];
const historyFilter = ref("");

const filteredHistory = computed(() => {
  if (!historyFilter.value) return historyRecords.value;
  return historyRecords.value.filter((r) => (r.category || "未分类") === historyFilter.value);
});

const categoryStats = computed(() => {
  const counts = {};
  for (const r of historyRecords.value) {
    const c = r.category || "未分类";
    counts[c] = (counts[c] || 0) + 1;
  }
  return counts;
});

async function setCategory(record, category) {
  try {
    const res = await fetch(`/api/history/${record.id}/category`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "保存失败");
    record.category = data.record?.category || category;
    appendLog(`已把「${record.fileName || "未命名"}」归到 ${record.category}`);
  } catch (error) {
    setStatus("error", `分类保存失败：${error.message}`);
  }
}
const selectedHistory = ref([]);

const health = ref(null);
const log = ref("");
const tab = ref("report");
const busy = ref({ frames: false, transcribe: false, ocr: false, analyze: false, review: false, compare: false, fission: false });
const status = ref({ tone: "idle", text: "等待上传素材" });

const canTranscribe = computed(() => Boolean(file.value) && !busy.value.transcribe);
const canAnalyze = computed(() => Boolean(file.value && frames.value.length) && !busy.value.analyze);
const canExport = computed(() => Boolean(sourceId.value && frames.value.length) && !exporting.value);
const canReview = computed(
  () => Object.keys(reviewSlots.value).length > 0 && !busy.value.review,
);
const canCompare = computed(() => Boolean(frames.value.length && finalFrames.value.length) && !busy.value.compare);
const reviewReady = computed(() => SHOT_SLOTS.filter((s) => reviewSlots.value[s.key]).length);

const elapsed = ref(0);
let elapsedTimer = null;

function setStatus(tone, text) {
  status.value = { tone, text };
  if (tone === "running") {
    if (!elapsedTimer) {
      elapsed.value = 0;
      elapsedTimer = setInterval(() => {
        elapsed.value += 1;
      }, 1000);
    }
  } else if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
    elapsed.value = 0;
  }
}

function switchMode(id) {
  mode.value = id;
  if (id === "history") loadHistoryList();
}

function appendLog(text) {
  const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  log.value = `[${stamp}] ${text}\n${log.value}`;
}

async function postJson(url, data) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.ok) throw new Error(payload.error || `接口返回 ${res.status}`);
  return payload;
}

async function loadHealth() {
  try {
    const res = await fetch("/api/health");
    health.value = await res.json();
  } catch (error) {
    appendLog(`读取服务状态失败：${error.message}`);
  }
}

/* ---------- 通用：转写一个文件 ---------- */
async function transcribeFile(targetFile, onProgress) {
  const { samples, duration } = await decodeAudioFromFile(targetFile);
  const chunks = makeAudioChunks(samples);
  appendLog(`音轨解码：${duration.toFixed(1)} 秒，${chunks.length} 个分片`);

  const all = [];
  for (const chunk of chunks) {
    onProgress?.(chunk, chunks.length);
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        "x-file-name": encodeURIComponent(`chunk-${String(chunk.index + 1).padStart(2, "0")}.wav`),
        "x-dialect": "auto",
        "x-product-hint": encodeURIComponent(productInput.value || ""),
        "x-audience-hint": encodeURIComponent(audienceInput.value || ""),
      },
      body: chunk.blob,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.ok) throw new Error(payload.error || `分片 ${chunk.index + 1} 返回 ${res.status}`);
    all.push(...offsetSegments(payload.segments || [], chunk.start));
  }
  return { segments: all, text: all.map((item) => item.text).join("") };
}

/* ---------- 模式一：拉片 ---------- */
async function pickFile(event) {
  const chosen = event.target.files?.[0];
  event.target.value = "";
  if (!chosen) return;

  file.value = chosen;
  frames.value = [];
  analysis.value = null;
  localAnalysis.value = null;
  segments.value = [];
  transcriptText.value = "";
  contactSheets.value = [];
  setStatus("idle", `已选择：${chosen.name}`);

  try {
    const info = await readVideoMeta(chosen);
    videoUrl.value = info.url;
    meta.value = { duration: info.duration, width: info.width, height: info.height };
    appendLog(`对标视频载入：${info.duration.toFixed(1)}s，${info.width}×${info.height}`);
    await nextTick();
    await doExtractFrames(info.element);
    await registerSource(chosen);
  } catch (error) {
    setStatus("error", error.message);
    appendLog(`载入失败：${error.message}`);
  }
}

async function doExtractFrames(explicitVideo) {
  const video = explicitVideo || videoEl.value;
  if (!video || !file.value) return;
  busy.value.frames = true;
  setStatus("running", "正在抽帧…");
  try {
    frames.value = await extractFrames(video, Number(shotCount.value) || 9);
    appendLog(`抽出 ${frames.value.length} 张关键帧`);
    setStatus("ok", `已抽取 ${frames.value.length} 张关键帧`);
  } catch (error) {
    setStatus("error", `抽帧失败：${error.message}`);
    appendLog(`抽帧失败：${error.message}`);
  } finally {
    busy.value.frames = false;
  }
}

/* ---------- 源视频缓存与分镜导出 ---------- */
async function registerSource(targetFile) {
  try {
    setStatus("running", "正在缓存源视频，供后续导出分镜…");
    const res = await fetch("/api/media/source", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-file-name": encodeURIComponent(targetFile.name),
      },
      body: await targetFile.arrayBuffer(),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload.ok) throw new Error(payload.error || `返回 ${res.status}`);
    sourceId.value = payload.sourceId;
    appendLog(`源视频已缓存：${payload.sourceId.slice(0, 10)}…（${(payload.size / 1024 / 1024).toFixed(1)}MB）`);
    setStatus("ok", "源视频已缓存，可分镜导出");
  } catch (error) {
    appendLog(`源视频缓存失败（不影响分析）：${error.message}`);
  }
}

async function doExportAll() {
  if (!sourceId.value) {
    setStatus("error", "源视频还没缓存完成，请稍等再试一次");
    return;
  }
  if (!frames.value.length) {
    setStatus("error", "还没有分镜，先抽帧");
    return;
  }

  let directory = "";
  try {
    directory = (await window.lapian?.pickDirectory?.()) || "";
  } catch (error) {
    appendLog(`目录选择失败：${error.message}`);
  }
  if (!directory) {
    setStatus("idle", "已取消导出");
    return;
  }

  exporting.value = true;
  exportInfo.value = null;
  setStatus("running", `正在导出 ${frames.value.length} 个分镜，逐个切片…`);
  try {
    const shots = frames.value.map((frame, index) => ({ index, start: frame.start, end: frame.end }));
    const payload = await postJson("/api/media/export", {
      sourceId: sourceId.value,
      directory,
      shots,
      prefix: "S",
    });
    exportInfo.value = { directory, ...payload };
    appendLog(`导出完成：${payload.total - payload.failed}/${payload.total} → ${directory}`);
    setStatus("ok", `已导出 ${payload.total - payload.failed} 个分镜`);
  } catch (error) {
    setStatus("error", `导出失败：${error.message}`);
    appendLog(`导出失败：${error.message}`);
  } finally {
    exporting.value = false;
  }
}

async function doTranscribe() {
  if (!file.value) return;
  busy.value.transcribe = true;
  setStatus("running", "正在解码音轨…");
  try {
    const result = await transcribeFile(file.value, (chunk, total) => {
      setStatus(
        "running",
        `转写分片 ${chunk.index + 1}/${total}（${formatTime(chunk.start)}-${formatTime(chunk.end)}）`,
      );
    });
    segments.value = result.segments;
    transcriptText.value = result.text;
    localAnalysis.value = buildLocalAnalysis({
      transcript: result.text,
      productInput: productInput.value,
      audienceInput: audienceInput.value,
      fileName: file.value.name,
      frameCount: frames.value.length,
    });
    appendLog(`转写完成：${result.segments.length} 段，${result.text.length} 字`);
    setStatus("ok", "转写完成，已生成本地初判");
    tab.value = "local";
  } catch (error) {
    setStatus("error", `转写失败：${error.message}`);
    appendLog(`转写失败：${error.message}`);
  } finally {
    busy.value.transcribe = false;
  }
}

/* ---------- 语音模型目录 ---------- */
async function openModelDir() {
  const result = await window.lapian?.openModelDir?.();
  if (result?.ok) {
    appendLog(`已打开模型目录：${result.path}`);
    setStatus("running", "把 ggml-small.bin 放进这个目录，然后重启应用");
  } else if (result?.error) {
    setStatus("error", `打开目录失败：${result.error}`);
  }
}

/* ---------- 画面字幕 OCR ---------- */
async function doOcr() {
  if (!file.value || !videoEl.value) {
    setStatus("error", "先上传视频再识别字幕");
    return;
  }
  busy.value.ocr = true;
  setStatus("running", "正在识别画面字幕（首次运行需联网下载中文包，约 20MB）…");
  try {
    let lastShown = -1;
    const result = await ocrSubtitles(videoEl.value, {
      interval: 0.6,
      onStatus: (status, percent) => {
        if (status.includes("language") || status.includes("initializ")) {
          setStatus("running", `正在准备中文语言包… ${percent}%（首次约 20MB）`);
        }
      },
      onProgress: (ratio, text) => {
        const percent = Math.round(ratio * 100);
        if (percent !== lastShown && percent % 5 === 0) {
          lastShown = percent;
          setStatus("running", `字幕识别 ${percent}%${text ? ` · ${text.slice(0, 10)}` : ""}`);
        }
      },
    });

    if (!result.length) {
      appendLog("OCR 未识别到有效字幕（画面可能没有硬字幕，或语言包没加载成功）");
      setStatus("idle", "没识别到字幕，可以手动填口播");
      return;
    }

    segments.value = result;
    transcriptText.value = result.map((item) => item.text).join("\n");
    localAnalysis.value = buildLocalAnalysis({
      transcript: transcriptText.value,
      productInput: productInput.value,
      audienceInput: audienceInput.value,
      fileName: file.value.name,
      frameCount: frames.value.length,
    });
    appendLog(
      `OCR 完成：${result.length} 段字幕（${formatTime(result[0].start)}-${formatTime(result[result.length - 1].end)}）`,
    );
    setStatus("ok", `识别出 ${result.length} 段字幕`);
    tab.value = "local";
  } catch (error) {
    setStatus("error", `OCR 失败：${error.message}`);
    appendLog(`OCR 失败：${error.message}｜首次运行需要联网下载中文语言包`);
  } finally {
    busy.value.ocr = false;
  }
}

async function doAnalyze() {
  if (!file.value) return;
  busy.value.analyze = true;
  setStatus("running", "正在生成分镜联系表并调用模型…");
  try {
    const cloudFrames = frames.value.map((frame, index) => ({
      index,
      start: frame.start,
      end: frame.end,
      subtitle: "",
      image: frame.image,
      phases: frame.phases || [],
    }));

    contactSheets.value = await buildContactSheets(cloudFrames);
    appendLog(`联系表：${contactSheets.value.length} 张（${contactSheets.value.map((s) => s.layout).join(" / ")}）`);

    const local =
      localAnalysis.value ||
      buildLocalAnalysis({
        transcript: transcriptText.value,
        productInput: productInput.value,
        audienceInput: audienceInput.value,
        fileName: file.value.name,
        frameCount: frames.value.length,
      });
    localAnalysis.value = local;

    const payload = await postJson("/api/analyze", {
      transcript: transcriptText.value,
      productInput: productInput.value,
      audienceInput: audienceInput.value,
      dialectMode: "auto",
      filename: file.value.name,
      duration: meta.value.duration,
      localAnalysis: local,
      frames: contactSheets.value.length ? cloudFrames.map((f) => ({ ...f, image: "" })) : cloudFrames,
      contactSheets: contactSheets.value,
    });

    analysis.value = payload.analysis || null;
    appendLog(`拉片完成，画面模式：${payload.visualMode}`);
    setStatus("ok", "拉片报告已生成");
    tab.value = "report";
    await saveCurrentRecord(analysis.value, local);
  } catch (error) {
    setStatus("error", `分析失败：${error.message}`);
    appendLog(`分析失败：${error.message}`);
  } finally {
    busy.value.analyze = false;
  }
}

/* ---------- 模式二：投放复盘 ---------- */
async function pickScreenshot(key, event) {
  const chosen = event.target.files?.[0];
  event.target.value = "";
  if (!chosen) return;
  try {
    const image = await imageFileToDataUrl(chosen);
    reviewSlots.value = {
      ...reviewSlots.value,
      [key]: { name: chosen.name, image },
    };
    appendLog(`已添加截图：${key} / ${chosen.name}`);
    setStatus("idle", `截图已就绪 ${Object.keys(reviewSlots.value).length}/4`);
  } catch (error) {
    setStatus("error", error.message);
  }
}

function clearScreenshot(key) {
  const next = { ...reviewSlots.value };
  delete next[key];
  reviewSlots.value = next;
}

async function doReview() {
  busy.value.review = true;
  setStatus("running", "正在读取投放截图并复盘…");
  try {
    const screenshots = SHOT_SLOTS.filter((slot) => reviewSlots.value[slot.key]).map((slot) => ({
      key: slot.key,
      title: slot.title,
      fileName: reviewSlots.value[slot.key].name,
      image: reviewSlots.value[slot.key].image,
    }));

    const notes = Array.isArray(analysis.value?.frameNotes) ? analysis.value.frameNotes : [];
    const payload = await postJson("/api/review", {
      filename: file.value?.name || "",
      duration: meta.value.duration || 0,
      localAnalysis: localAnalysis.value || {},
      // 让模型能把截图里的曲线峰值落到具体分镜上
      storyboardFrames: frames.value.map((frame, index) => ({
        index,
        start: frame.start,
        end: frame.end,
        subtitle: notes[index]?.subtitle || "",
        mainEvent: notes[index]?.mainEvent || "",
        speechIntent: notes[index]?.speechIntent || "",
      })),
      productContext: {
        product: productInput.value,
        audience: audienceInput.value,
        whatIsSold: analysis.value?.whatIsSold || "",
        coreSellingPoint: analysis.value?.selling || "",
      },
      screenshots,
    });

    review.value = payload.review || null;
    appendLog(`复盘完成，判定：${review.value?.verdict || "—"}`);
    setStatus("ok", "投放复盘已生成");
  } catch (error) {
    setStatus("error", `复盘失败：${error.message}`);
    appendLog(`复盘失败：${error.message}`);
  } finally {
    busy.value.review = false;
  }
}

/* ---------- 模式三：终局对比 ---------- */
async function pickFinalFile(event) {
  const chosen = event.target.files?.[0];
  event.target.value = "";
  if (!chosen) return;

  finalFile.value = chosen;
  finalFrames.value = [];
  finalTranscript.value = "";
  compare.value = null;
  setStatus("idle", `成品视频：${chosen.name}`);

  try {
    const info = await readVideoMeta(chosen);
    finalVideoUrl.value = info.url;
    finalMeta.value = { duration: info.duration, width: info.width, height: info.height };
    finalFrames.value = await extractFrames(info.element, Number(shotCount.value) || 9);
    appendLog(`成品视频载入并抽帧 ${finalFrames.value.length} 张`);
    setStatus("ok", "成品视频已就绪");
  } catch (error) {
    setStatus("error", error.message);
    appendLog(`成品视频载入失败：${error.message}`);
  }
}

async function doTranscribeFinal() {
  if (!finalFile.value) return;
  busy.value.transcribe = true;
  setStatus("running", "正在转写成品音频…");
  try {
    const result = await transcribeFile(finalFile.value, (chunk, total) => {
      setStatus("running", `成品转写 ${chunk.index + 1}/${total}`);
    });
    finalTranscript.value = result.text;
    appendLog(`成品转写完成：${result.text.length} 字`);
    setStatus("ok", "成品音频转写完成");
  } catch (error) {
    setStatus("error", `成品转写失败：${error.message}`);
    appendLog(`成品转写失败：${error.message}`);
  } finally {
    busy.value.transcribe = false;
  }
}

async function doCompare() {
  if (!frames.value.length || !finalFrames.value.length) return;
  busy.value.compare = true;
  setStatus("running", "正在拼配对联系表并逐镜对比…");
  try {
    const benchmarkFrames = frames.value.slice(0, 6);
    const finalFramesSix = finalFrames.value.slice(0, 6);
    const sheets = await buildPairedContactSheet(benchmarkFrames, finalFramesSix);
    appendLog(`配对联系表：${sheets[0]?.layout || "—"}`);

    // 按营销结构分 4 段对比，而不是按物理镜头等分
    const shotPairs = compareSegmentViews.value.map((seg, index) => ({
      index,
      title: seg.title,
      benchmarkTime: seg.benchmarkTime || "未定",
      finalTime: seg.finalTime || "未定",
      benchmarkDetail: seg.benchmarkText,
      finalDetail: seg.finalText,
      hint: seg.hint,
    }));

    const benchmarkDuration = Number(meta.value.duration) || 0;
    const finalDuration = Number(finalMeta.value.duration) || 0;
    const durationGap = Math.abs(benchmarkDuration - finalDuration);

    // 原版规则：同一时间轴且差异在容差内不因偏移扣分；时长差大则按相对进度比
    const timelineAlignment = {
      mode: durationGap < 1 ? "same_file" : "scaled_relative",
      timeToleranceSeconds: 0.5,
      benchmarkDuration,
      finalDuration,
      note:
        durationGap < 1
          ? "两条视频时长基本一致，视为同一时间轴"
          : `时长相差 ${durationGap.toFixed(1)} 秒，按相同分镜的相对进度比较，不要求绝对秒数相同`,
    };
    appendLog(`时间轴对齐：${timelineAlignment.mode}（时长差 ${durationGap.toFixed(1)}s）`);

    const payload = await postJson("/api/final-compare", {
      benchmark: localAnalysis.value || {},
      final: {
        transcript: finalTranscript.value,
        filename: finalFile.value?.name || "",
        duration: finalMeta.value.duration || 0,
      },
      shotPairs,
      timelineAlignment,
      notes: "",
      benchmarkFrames: benchmarkFrames.map((f) => ({ start: f.start, end: f.end, image: f.image })),
      finalFrames: finalFramesSix.map((f) => ({ start: f.start, end: f.end, image: f.image })),
      contactSheets: compareMode.value === "deep" ? sheets : [],
    });

    compare.value = payload.result || null;
    appendLog(`对比完成，模式：${compare.value?.apiCompareMode || "—"}，总分 ${compare.value?.score ?? "—"}`);
    setStatus("ok", `终局对比完成，总分 ${compare.value?.score ?? "—"}`);
  } catch (error) {
    setStatus("error", `对比失败：${error.message}`);
    appendLog(`对比失败：${error.message}`);
  } finally {
    busy.value.compare = false;
  }
}

/* ---------- 模式四：逐镜裂变 ---------- */
async function doFission() {
  if (!analysis.value || !frames.value.length) {
    setStatus("error", "先完成 AI 拉片，才有分镜可以裂变");
    return;
  }
  busy.value.fission = true;
  setStatus("running", "正在生成槽位裂变矩阵，这一步输出较长…");
  try {
    const notes = Array.isArray(analysis.value.frameNotes) ? analysis.value.frameNotes : [];
    const shotFrames = frames.value.map((frame, index) => {
      const note = notes[index] || {};
      return {
        index,
        start: frame.start,
        end: frame.end,
        speech: note.subtitle || note.adaptedSpeech || "",
        visualDescription: note.visualDescription || "",
      };
    });

    const payload = await postJson("/api/fission", {
      productProfile: { ...fissionProfile.value },
      fissionGoal: fissionProfile.value.goal,
      fullTranscript: transcriptText.value,
      analysisSummary: {
        layer: analysis.value.layer,
        opening: analysis.value.opening,
        selling: analysis.value.selling,
        middleMode: analysis.value.middleMode,
        ending: analysis.value.ending,
        structure: analysis.value.structure,
        whatIsSold: analysis.value.whatIsSold,
        sixLineSummary: analysis.value.sixLineSummary,
      },
      frames: shotFrames,
    });

    fission.value = payload.fission || null;
    appendLog(`裂变完成：${fission.value?.shots?.length || 0} 个槽位`);
    setStatus("ok", "裂变矩阵已生成");
  } catch (error) {
    setStatus("error", `裂变失败：${error.message}`);
    appendLog(`裂变失败：${error.message}`);
  } finally {
    busy.value.fission = false;
  }
}

/* ---------- 模式五：历史记录 ---------- */
async function loadHistoryList() {
  historyLoading.value = true;
  try {
    const res = await fetch("/api/history");
    const payload = await res.json();
    historyRecords.value = payload.records || [];
  } catch (error) {
    appendLog(`读取历史失败：${error.message}`);
  } finally {
    historyLoading.value = false;
  }
}

async function openRecord(id) {
  try {
    const res = await fetch(`/api/history/${id}`);
    const payload = await res.json();
    if (!res.ok || !payload.ok) throw new Error(payload.error || `返回 ${res.status}`);
    const rec = payload.record;

    analysis.value = rec.analysis || null;
    localAnalysis.value = rec.localAnalysis || null;
    transcriptText.value = rec.transcript || "";
    productInput.value = rec.productInput || "";
    audienceInput.value = rec.audienceInput || "";
    frames.value = Array.isArray(rec.frames) ? rec.frames : [];
    meta.value = { duration: rec.duration || 0, width: 0, height: 0 };
    file.value = null;
    videoUrl.value = "";
    sourceId.value = rec.sourceId || "";
    mode.value = "lapian";
    tab.value = "report";

    appendLog(`载入历史：${rec.fileName || rec.id}`);
    setStatus("ok", `已载入历史记录（${formatTime(rec.duration)}）`);
  } catch (error) {
    setStatus("error", `载入失败：${error.message}`);
  }
}

async function removeRecord(id) {
  try {
    await fetch(`/api/history/${id}`, { method: "DELETE" });
    await loadHistoryList();
    appendLog(`已删除历史 ${String(id).slice(0, 10)}…`);
  } catch (error) {
    appendLog(`删除失败：${error.message}`);
  }
}

/* ---------- 历史批量导出（CSV，可直接导入飞书表格） ---------- */
function toggleHistory(id) {
  const index = selectedHistory.value.indexOf(id);
  if (index >= 0) selectedHistory.value.splice(index, 1);
  else selectedHistory.value.push(id);
}

const allHistorySelected = computed(
  () => historyRecords.value.length > 0 && selectedHistory.value.length === historyRecords.value.length,
);

function toggleAllHistory() {
  selectedHistory.value = allHistorySelected.value ? [] : historyRecords.value.map((item) => item.id);
}

function csvCell(value) {
  const text = String(value ?? "").replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildHistoryCsv(records) {
  const headers = [
    "文件名",
    "时长",
    "分类",
    "开头钩子",
    "结尾模式",
    "卖什么",
    "卖给谁",
    "三段论",
    "核心卖点",
    "修改建议",
    "分镜数",
    "产品",
    "人群",
    "创建时间",
  ];
  const rows = records.map((record) => {
    const a = record.analysis || {};
    return [
      record.fileName,
      formatTime(record.duration || 0),
      a.layer || record.layer,
      a.opening || record.opening,
      a.ending,
      a.whatIsSold || record.product,
      a.whoIsTarget,
      a.structure || a.methodologyStructure,
      (Array.isArray(a.sellingMethods) ? a.sellingMethods.join("、") : "") || a.selling,
      a.editIdea,
      (record.frames || []).length,
      record.productInput,
      record.audienceInput,
      new Date(record.createdAt).toLocaleString("zh-CN", { hour12: false }),
    ]
      .map(csvCell)
      .join(",");
  });
  // BOM 前缀，Excel 才不会把中文读成乱码
  return "\uFEFF" + [headers.join(","), ...rows].join("\r\n");
}

async function exportSelectedHistory() {
  const ids = selectedHistory.value.length
    ? [...selectedHistory.value]
    : historyRecords.value.map((item) => item.id);
  if (!ids.length) {
    setStatus("error", "没有可导出的记录");
    return;
  }

  setStatus("running", `正在整理 ${ids.length} 条记录…`);
  try {
    const records = [];
    for (const id of ids) {
      const res = await fetch(`/api/history/${id}`);
      const payload = await res.json();
      if (payload.ok && payload.record) records.push(payload.record);
    }
    if (!records.length) throw new Error("记录读取失败");

    const csv = buildHistoryCsv(records);
    const stamp = new Date().toISOString().slice(0, 10);
    if (window.lapian?.saveFile) {
      const saved = await window.lapian.saveFile(`拉片历史-${stamp}.csv`, csv);
      if (!saved?.ok) throw new Error(saved?.error || "保存失败");
      appendLog(`已导出 ${records.length} 条 → ${saved.path}`);
      setStatus("ok", `已导出 ${records.length} 条记录`);
    } else {
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `拉片历史-${stamp}.csv`;
      link.click();
      setStatus("ok", `已导出 ${records.length} 条记录`);
    }
  } catch (error) {
    setStatus("error", `导出失败：${error.message}`);
    appendLog(`历史导出失败：${error.message}`);
  }
}

async function saveCurrentRecord(payloadAnalysis, local) {
  if (!payloadAnalysis) return;
  try {
    const saved = await postJson("/api/history", {
      fileName: file.value?.name || "",
      duration: meta.value.duration,
      sourceId: sourceId.value,
      productInput: productInput.value,
      audienceInput: audienceInput.value,
      transcript: transcriptText.value,
      localAnalysis: local,
      analysis: payloadAnalysis,
      frames: frames.value,
    });
    appendLog(`已存入历史：${saved.record.id}`);
  } catch (error) {
    appendLog(`历史保存失败（不影响本次结果）：${error.message}`);
  }
}

/* ---------- 展示用派生数据 ---------- */
const sixLines = computed(() => (Array.isArray(analysis.value?.sixLineSummary) ? analysis.value.sixLineSummary : []));
const frameNotes = computed(() => (Array.isArray(analysis.value?.frameNotes) ? analysis.value.frameNotes : []));
/* ---------- 图5 固定 4 段对比（营销结构，不是物理镜头） ---------- */
const COMPARE_SEGMENTS = [
  {
    key: "hook",
    title: "开头钩子",
    hint: "前 3 秒怎么抓人：结果前置 / 警示避坑 / 提问 / 反差",
    benchmarkPh: "例：结果前置，先给效果再讲产品",
    finalPh: "例：沿用结果前置，但慢了 1 秒才给结果",
  },
  {
    key: "selling",
    title: "卖点铺垫",
    hint: "中段怎么把核心卖点讲清楚、讲透",
    benchmarkPh: "例：一个卖点配一个动作，边演示边说",
    finalPh: "例：口播说了三个卖点，画面只演示了一个",
  },
  {
    key: "trust",
    title: "信任补强",
    hint: "用什么证明：实拍对比 / 资质 / 真实评价 / 数据",
    benchmarkPh: "例：实拍对比实验，前后画面同框",
    finalPh: "例：只有口播承诺，没有画面证据",
  },
  {
    key: "cta",
    title: "结尾转化",
    hint: "最后怎么逼单：价格锚点 / 限时 / 明确指令",
    benchmarkPh: "例：价格锚点 + 立即下单指令",
    finalPh: "例：只说「链接在下面」，没有紧迫感",
  },
];

const compareMode = ref("deep");
const compareSegments = ref(
  Object.fromEntries(COMPARE_SEGMENTS.map((seg) => [seg.key, { benchmark: "", final: "" }])),
);

const compareSegmentViews = computed(() => {
  const benchmarkDuration = Number(meta.value.duration) || 0;
  const finalDuration = Number(finalMeta.value.duration) || 0;
  const span = (total, index) => {
    if (!total) return "";
    const from = (total * index) / COMPARE_SEGMENTS.length;
    const to = (total * (index + 1)) / COMPARE_SEGMENTS.length;
    return `${formatTime(from)}-${formatTime(to)}`;
  };
  return COMPARE_SEGMENTS.map((seg, index) => ({
    ...seg,
    benchmarkTime: span(benchmarkDuration, index),
    finalTime: span(finalDuration, index),
    benchmarkText: compareSegments.value[seg.key]?.benchmark || "",
    finalText: compareSegments.value[seg.key]?.final || "",
  }));
});

const compareShots = computed(() => (Array.isArray(compare.value?.shots) ? compare.value.shots : []));
const compareRows = computed(() => (Array.isArray(compare.value?.rows) ? compare.value.rows : []));
const compareSuggestions = computed(() =>
  Array.isArray(compare.value?.suggestions) ? compare.value.suggestions : [],
);
const fissionShots = computed(() => (Array.isArray(fission.value?.shots) ? fission.value.shots : []));
const canFission = computed(() => Boolean(analysis.value && frames.value.length) && !busy.value.fission);
const reviewFindings = computed(() =>
  Array.isArray(review.value?.screenshotFindings) ? review.value.screenshotFindings : [],
);
const reviewActions = computed(() =>
  Array.isArray(review.value?.recommendations) ? review.value.recommendations : [],
);
const localRows = computed(() => {
  const l = localAnalysis.value;
  if (!l) return [];
  return [
    ["产品", l.product],
    ["内容分类", l.layer],
    ["分类依据", l.layerReason],
    ["视角", l.perspective],
    ["人群", l.audience],
    ["黄金 3 秒", l.opening],
    ["卖点方向", l.selling],
    ["中段种草", l.middleMode],
    ["结尾", l.ending],
    ["结构", l.structure],
  ];
});

/* ---------- 设置 ---------- */
const settingsOpen = ref(false);
const testing = ref(false);
const testResult = ref("");
const VISION_PRESETS = {
  qwen: {
    label: "通义千问 VL",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3-vl-plus",
  },
  zhipu: {
    label: "智谱 GLM-4V",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4v-plus",
  },
  ark: {
    label: "豆包 Vision",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "",
  },
};

const settingsForm = ref({
  baseUrl: "",
  apiKey: "",
  model: "",
  visionBaseUrl: "",
  visionApiKey: "",
  visionModel: "",
  transcribeModel: "ggml-small.bin",
  glossaryText: "",
  productHint: "",
  audienceHint: "",
});

function applyVisionPreset(key) {
  const preset = VISION_PRESETS[key];
  if (!preset) return;
  settingsForm.value.visionBaseUrl = preset.baseUrl;
  settingsForm.value.visionModel = preset.model;
}

async function openSettings() {
  settingsOpen.value = true;
  testResult.value = "";
  try {
    const res = await fetch("/api/settings");
    const payload = await res.json();
    const s = payload.settings || {};
    settingsForm.value = {
      baseUrl: s.baseUrl || "",
      apiKey: "",
      model: s.model || "",
      visionBaseUrl: s.visionBaseUrl || "",
      visionApiKey: "",
      visionModel: s.visionModel || "",
      transcribeModel: s.transcribeModel || "ggml-small.bin",
      glossaryText: (s.glossary || []).join("、"),
      productHint: s.productHint || "",
      audienceHint: s.audienceHint || "",
    };
  } catch (error) {
    appendLog(`读取设置失败：${error.message}`);
  }
}

async function saveSettings() {
  try {
    const f = settingsForm.value;
    const patch = {
      baseUrl: String(f.baseUrl || "").trim(),
      model: String(f.model || "").trim(),
      visionBaseUrl: String(f.visionBaseUrl || "").trim(),
      visionModel: String(f.visionModel || "").trim(),
      transcribeModel: f.transcribeModel,
      glossary: String(f.glossaryText || "")
        .split(/[、,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
      productHint: f.productHint,
      audienceHint: f.audienceHint,
    };
    if (String(f.apiKey || "").trim()) patch.apiKey = String(f.apiKey).trim();
    if (String(f.visionApiKey || "").trim()) patch.visionApiKey = String(f.visionApiKey).trim();
    await postJson("/api/settings", patch);
    await loadHealth();
    settingsOpen.value = false;
    appendLog("设置已保存");
    setStatus("ok", "设置已保存");
  } catch (error) {
    testResult.value = `保存失败：${error.message}`;
  }
}

async function testApi() {
  testing.value = true;
  testResult.value = "测试中（会先用已保存的配置）…";
  try {
    const payload = await postJson("/api/ai/test", {});
    testResult.value = `连通正常：${payload.reply || "OK"}`;
  } catch (error) {
    testResult.value = `连接失败：${error.message}`;
  } finally {
    testing.value = false;
  }
}

/* ---------- 图2 分镜拉片矩阵 ---------- */
const STORYBOARD_ROWS = [
  { key: "visual", label: "画面分析" },
  { key: "layer", label: "内容分类" },
  { key: "role", label: "镜头作用" },
  { key: "pain", label: "疑似痛点" },
  { key: "adjust", label: "展示调整" },
  { key: "speech", label: "口播文案" },
];

/* 结构标签：拉片的核心分类，可筛选可统计 */
const STRUCTURE_TAGS = [
  { key: "开场钩子", color: "#E24B4A" },
  { key: "情绪铺垫", color: "#EF9F27" },
  { key: "核心观点", color: "#378ADD" },
  { key: "案例细节", color: "#639922" },
  { key: "情感升华", color: "#1D9E75" },
  { key: "结尾引导", color: "#7F77DD" },
];

const tagColor = (tag) => STRUCTURE_TAGS.find((t) => t.key === tag)?.color || "#5F6573";
const tagFilter = ref("");

const storyboardColumns = computed(() => {
  const list = frames.value || [];
  if (!list.length) return [];
  const a = analysis.value;
  const notes = Array.isArray(a?.frameNotes) ? a.frameNotes : [];
  const layerText = a?.layer ? `${a.layer} 类` : "待补证据";
  const perspectiveText = a?.perspective || "视角待定";

  return list.map((frame, index) => {
    const note = notes[index] || {};
    return {
      index,
      image: frame.image || "",
      // 有源视频缓存时给出可播放的片段地址（GET + Range）
      clipUrl: sourceId.value
        ? `/api/media/clip-stream?sourceId=${encodeURIComponent(sourceId.value)}&start=${Number(frame.start).toFixed(2)}&end=${Number(frame.end).toFixed(2)}`
        : "",
      start: Number(frame.start) || 0,
      end: Number(frame.end) || 0,
      timeRange: `${formatTime(frame.start)}-${formatTime(frame.end)}`,
      structureTag: String(note.structureTag || "").trim(),
      visual: String(note.visualDescription || "").trim() || "该分镜未识别到画面描述，先跑一次 AI 拉片",
      layer: layerText,
      perspective: perspectiveText,
      role: String(note.sourceRole || "").trim() || (index === 0 ? "开头待定" : "推进信息逻辑"),
      pain: String(note.speechIntent || note.adaptedSpeech || "").trim() || "待补画面 / 口播证据",
      speech: String(note.subtitle || "").trim() || "未识别到稳定画面字幕",
    };
  });
});

/* 按结构标签筛选后的分镜列 */
const filteredColumns = computed(() => {
  if (!tagFilter.value) return storyboardColumns.value;
  return storyboardColumns.value.filter((c) => c.structureTag === tagFilter.value);
});

/* 各标签命中数量，用于顶部统计 */
const tagStats = computed(() => {
  const counts = {};
  for (const col of storyboardColumns.value) {
    if (!col.structureTag) continue;
    counts[col.structureTag] = (counts[col.structureTag] || 0) + 1;
  }
  return counts;
});

const hasTags = computed(() => Object.keys(tagStats.value).length > 0);

async function downloadFrame(column) {  const frame = frames.value[column.index];
  if (!frame) {
    setStatus("error", "这一镜没有数据");
    return;
  }

  // 首选：切出该分镜的视频片段（复刻时真正要用的东西）
  if (sourceId.value && window.lapian?.getDownloadsDir) {
    try {
      setStatus("running", `正在切第 ${column.index + 1} 镜的片段…`);
      const directory = await window.lapian.getDownloadsDir();
      const payload = await postJson("/api/media/export", {
        sourceId: sourceId.value,
        directory,
        shots: [{ index: column.index, start: frame.start, end: frame.end }],
        prefix: "分镜",
      });
      const item = payload.results?.[0];
      if (!item?.ok) throw new Error(item?.error || "切片失败");
      appendLog(`已导出片段：${item.name} → ${directory}`);
      setStatus("ok", `片段已保存：${item.name}`);
      return;
    } catch (error) {
      appendLog(`片段导出失败，降级为截图：${error.message}`);
    }
  }

  // 降级：源视频缓存缺失时只能给截图
  if (!frame.image) {
    setStatus("error", "源视频未缓存，且这一镜没有截图");
    return;
  }
  try {
    if (window.lapian?.savePng) {
      const saved = await window.lapian.savePng(frame.image, `分镜${column.index + 1}.jpg`);
      if (saved?.ok) {
        setStatus("ok", `源视频未缓存，已改存截图：${saved.path}`);
        return;
      }
    }
    const link = document.createElement("a");
    link.href = frame.image;
    link.download = `分镜${column.index + 1}.jpg`;
    link.click();
    setStatus("ok", "源视频未缓存，已下载截图");
  } catch (error) {
    setStatus("error", `下载失败：${error.message}`);
  }
}

/* ---------- 脚本总结 / 画面总结（对齐 0.1.18 的 14 项） ---------- */
const scriptSummary = computed(() => {
  const a = analysis.value;
  if (!a) return [];
  const pick = (value, fallback) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text ? { value: text, pending: false } : { value: fallback, pending: true };
  };
  const six =
    Array.isArray(a.sixLineSummary) && a.sixLineSummary.length
      ? a.sixLineSummary.map((item) => `${item.label}：${item.value}`).join(" / ")
      : "";
  const methods = Array.isArray(a.sellingMethods) && a.sellingMethods.length
    ? a.sellingMethods.join("、")
    : a.selling;

  return [
    { label: "卖什么", ...pick(a.whatIsSold, "商品 / 产品 / 品类待定") },
    { label: "卖给谁", ...pick(a.whoIsTarget, "人群待定") },
    { label: "吸引理由", ...pick(a.attractionReason, "开头 3 秒证据待定") },
    { label: "促成理由", ...pick(a.conversionReason, "转化证据待定") },
    { label: "三段论", ...pick(a.structure || a.methodologyStructure, "缺少有效口播 / 字幕证据") },
    { label: "脚本框架", ...pick(a.framework?.path || a.framework?.label, "结构待定") },
    { label: "多线剧本", ...pick(six, "本线 / 主线 / 支线待定") },
    { label: "黄金3秒", ...pick(a.opening, "开头 3 秒口播 / 字幕未识别") },
    { label: "中段方法", ...pick(a.middleMode, "中段种草方式待定") },
    { label: "结尾模式", ...pick(a.ending, "结尾模式待定") },
    { label: "主角场景", ...pick(a.scene, "场景待定") },
    { label: "识别信号", ...pick(a.signal || a.perspectiveSignal, "画面描述待定") },
    { label: "实际操作", ...pick(methods, "使用 / 演示动作待定") },
    { label: "观看人群", ...pick(a.audience || a.audienceHits?.join("、"), "人群待定") },
  ];
});

const visualSummaryData = computed(() => {
  const a = analysis.value;
  if (!a) return [];
  const notes = Array.isArray(a.frameNotes) ? a.frameNotes : [];
  const speechShots = notes.filter((note) => String(note?.speechIntent || "").trim()).length;
  const sellingCount = Array.isArray(a.sellingMethods) ? a.sellingMethods.length : a.selling ? 1 : 0;
  return [
    { label: "出镜人物", value: speechShots ? `${speechShots} 镜有人物口播` : "待核" },
    { label: "核心卖点", value: sellingCount ? `${sellingCount} 个` : "待定" },
    { label: "情绪基调", value: a.middleMode || "待定" },
    { label: "章节分布", value: a.structure ? "已识别" : "三段论待定" },
  ];
});

/* ---------- 图片导出（html2canvas，2x PNG） ---------- */
const exportingPng = ref(false);

const EXPORT_TARGETS = {
  lapian: { selector: ".col.right .report", name: "图1-框架拆解.png", width: 1080 },
  // 分镜表自身已按列宽撑开，导出时保持原宽
  storyboard: { selector: ".sb-table", name: "图2-分镜拉片.png", width: 0 },
  review: { selector: ".col.right .report", name: "图3-爆款复盘.png", width: 1080 },
  compare: { selector: ".col.right .report", name: "图4-成品分析.png", width: 1080 },
  fission: { selector: ".col.right .report", name: "图5-爆款迭化.png", width: 1080 },
};

async function exportCurrent() {
  const target = EXPORT_TARGETS[mode.value];
  if (!target) {
    setStatus("idle", "当前页面没有可导出的报告");
    return;
  }
  const node = document.querySelector(target.selector);
  if (!node) {
    setStatus("error", "没有找到可导出的内容");
    return;
  }
  if (node.textContent.replace(/\s+/g, "").length < 20) {
    setStatus("error", "报告还是空的，先跑一次分析再导出");
    return;
  }

  exportingPng.value = true;
  setStatus("running", "正在生成 2 倍高清图片…");

  // 导出时把报告临时脱离三栏布局、拉宽到 1080，避免窄栏挤压排版
  const prev = {
    position: node.style.position,
    left: node.style.left,
    top: node.style.top,
    width: node.style.width,
    height: node.style.height,
    maxHeight: node.style.maxHeight,
    overflow: node.style.overflow,
    zIndex: node.style.zIndex,
    background: node.style.background,
    scrollTop: node.scrollTop,
  };
  node.scrollTop = 0;
  node.style.position = "fixed";
  node.style.left = "0";
  node.style.top = "0";
  node.style.zIndex = "-1";
  if (target.width) node.style.width = `${target.width}px`;
  node.style.height = "auto";
  node.style.maxHeight = "none";
  node.style.overflow = "visible";
  node.style.background = "#0f1115";

  try {
    await nextTick();
    const canvas = await html2canvas(node, {
      backgroundColor: "#0f1115",
      scale: 2,
      useCORS: true,
      logging: false,
      windowWidth: target.width ? target.width + 120 : Math.max(1200, node.scrollWidth),
      windowHeight: Math.max(1200, node.scrollHeight),
      scrollX: 0,
      scrollY: 0,
    });
    const dataUrl = canvas.toDataURL("image/png");
    appendLog(`已生成图片：${canvas.width}×${canvas.height}`);

    if (window.lapian?.savePng) {
      const saved = await window.lapian.savePng(dataUrl, target.name);
      if (!saved?.ok) throw new Error(saved?.error || "保存失败");
      appendLog(`已保存到：${saved.path}`);
      setStatus("ok", `图片已保存：${saved.path}`);
    } else {
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = target.name;
      link.click();
      setStatus("ok", "图片已导出到下载目录");
    }
  } catch (error) {
    setStatus("error", `导出失败：${error.message}`);
    appendLog(`图片导出失败：${error.message}`);
  } finally {
    node.style.position = prev.position;
    node.style.left = prev.left;
    node.style.top = prev.top;
    node.style.width = prev.width;
    node.style.height = prev.height;
    node.style.maxHeight = prev.maxHeight;
    node.style.overflow = prev.overflow;
    node.style.zIndex = prev.zIndex;
    node.style.background = prev.background;
    node.scrollTop = prev.scrollTop;
    exportingPng.value = false;
  }
}

onMounted(() => {
  loadHealth();
  window.addEventListener("keydown", onLightboxKey);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onLightboxKey);
});
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="dot" />
        <h1>拉片工作台</h1>
      </div>

      <nav class="modes">
        <button
          v-for="item in MODES"
          :key="item.id"
          :class="{ on: mode === item.id }"
          @click="switchMode(item.id)"
        >
          {{ item.label }}
        </button>
      </nav>

      <div class="status" :data-tone="status.tone">
        {{ status.text }}
        <span v-if="elapsed" class="elapsed">{{ elapsed }}s</span>
      </div>

      <div class="health">
        <span :class="['pill', health?.whisper?.ready ? 'ok' : 'bad']">
          转写 {{ health?.whisper?.ready ? "就绪" : "缺失" }}
        </span>
        <button class="pill clickable" :disabled="exportingPng" @click="exportCurrent">
          {{ exportingPng ? "导出中…" : "导出图片" }}
        </button>
        <button
          :class="['pill', 'clickable', health?.settings?.apiKeySet ? 'ok' : 'bad']"
          @click="openSettings"
        >
          API {{ health?.settings?.apiKeySet ? "已配置" : "未配置" }}
        </button>
      </div>
    </header>

    <div v-if="health?.settings && !health.settings.apiKeySet" class="setup-banner">
      <span>
        <strong>还差一步</strong>
        ：模型地址和模型名已经预填好，只需要填一次 API Key 就能开始分析
      </span>
      <button class="mini" @click="openSettings">去填 Key</button>
    </div>

    <!-- ================= 拉片分析 ================= -->
    <main v-if="mode === 'lapian'" class="grid">
      <section class="col left">
        <div class="card">
          <h2>素材</h2>
          <label class="upload">
            <input type="file" accept="video/*" @change="pickFile" />
            <span>{{ file ? file.name : "点击选择视频文件" }}</span>
          </label>
          <div v-if="meta.duration" class="meta">
            {{ formatTime(meta.duration) }} · {{ meta.width }}×{{ meta.height }}
          </div>
        </div>

        <div class="card">
          <h2>分析参数</h2>
          <label class="field">
            <span>产品 / 品牌</span>
            <input v-model="productInput" placeholder="例：橙言牙套收纳盒" />
          </label>
          <label class="field">
            <span>目标人群 / 场景</span>
            <input v-model="audienceInput" placeholder="例：25-35 岁正畸人群" />
          </label>
          <label class="field">
            <span>分镜数量</span>
            <input v-model.number="shotCount" type="number" min="3" max="18" />
          </label>
          <button class="wide" :disabled="busy.frames || !file" @click="doExtractFrames()">重新抽帧</button>
        </div>

        <div class="card">
          <h2>流水线</h2>
          <button class="wide" :disabled="!canTranscribe" @click="doTranscribe">
            {{ busy.transcribe ? "转写中…" : "① 本地转写口播" }}
          </button>
          <div v-if="health?.whisper && !health.whisper.modelExists" class="model-alert">
            <strong>语音模型未安装</strong>
            <p>拉片分析仍可跑，但没有口播文本，结果会缺「三段论 / 口播文案」。</p>
            <code>{{ health.whisper.model }}</code>
            <button class="mini" @click="openModelDir">打开模型目录</button>
          </div>
          <button class="wide" :disabled="!file || busy.ocr" @click="doOcr">
            {{ busy.ocr ? "识别字幕中…" : "识别画面字幕（OCR）" }}
          </button>
          <button class="wide primary" :disabled="!canAnalyze" @click="doAnalyze">
            {{ busy.analyze ? "分析中…" : "② AI 拉片分析" }}
          </button>
          <p class="hint">
            ① 纯本地运行，不花钱；OCR 用于没有音轨、只有硬字幕的素材；② 会把分镜联系表发给模型，产生费用。
          </p>
        </div>

        <div class="card">
          <h2>分镜导出 <em v-if="frames.length">{{ frames.length }} 段</em></h2>
          <button class="wide" :disabled="!canExport" @click="doExportAll">
            {{ exporting ? "切片中…" : "导出全部分镜视频" }}
          </button>
          <p class="hint">
            用内置 ffmpeg 把每个分镜切成 mp4（h264/aac），直接丢给剪辑师复刻。
            <template v-if="!sourceId">源视频正在缓存或未上传。</template>
          </p>
          <div v-if="exportInfo" class="export-out">
            已导出 {{ exportInfo.total - exportInfo.failed }}/{{ exportInfo.total }}
            <template v-if="exportInfo.failed">（{{ exportInfo.failed }} 段失败）</template>
            <div class="export-dir">{{ exportInfo.directory }}</div>
          </div>
        </div>
      </section>

      <section class="col mid">
        <div class="card video-card">
          <video ref="videoEl" :src="videoUrl" controls playsinline />
          <div v-if="!file" class="empty">还没有视频</div>
        </div>

        <div class="card">
          <h2>关键帧 <em v-if="frames.length">{{ frames.length }} 张</em></h2>
          <div class="strip">
            <figure v-for="frame in frames" :key="frame.index" @click="openLightbox(frame.index)">
              <img :src="frame.image" :alt="`分镜 ${frame.index + 1}`" />
              <figcaption>S{{ frame.index + 1 }} · {{ formatTime(frame.start) }}</figcaption>
            </figure>
            <div v-if="!frames.length" class="empty small">抽帧后会出现在这里</div>
          </div>
        </div>

        <div class="card">
          <h2>口播文本 <em v-if="transcriptText">{{ transcriptText.length }} 字</em></h2>
          <textarea v-model="transcriptText" rows="6" placeholder="转写结果会填在这里，也可以手动修改后重新分析" />
        </div>
      </section>

      <section class="col right">
        <div class="card grow">
          <div class="tabs">
            <button :class="{ on: tab === 'report' }" @click="tab = 'report'">拉片报告</button>
            <button :class="{ on: tab === 'local' }" @click="tab = 'local'">本地初判</button>
            <button :class="{ on: tab === 'log' }" @click="tab = 'log'">运行日志</button>
          </div>

          <div v-if="tab === 'report'" class="report">
            <div v-if="!analysis" class="empty small">还没有 AI 分析结果</div>
            <template v-else>
              <div class="badges">
                <span class="badge">{{ analysis.layer || "未分类" }}</span>
                <span class="badge">{{ analysis.opening || "开头未识别" }}</span>
                <span class="badge">{{ analysis.ending || "结尾未识别" }}</span>
              </div>

              <h3>脚本总结 <em>14 项</em></h3>
              <div class="summary-grid">
                <div v-for="item in scriptSummary" :key="item.label" class="sum-item">
                  <span class="sum-label">{{ item.label }}</span>
                  <span class="sum-value" :class="{ pending: item.pending }">{{ item.value }}</span>
                </div>
              </div>

              <h3>画面总结</h3>
              <div class="visual-summary">
                <div v-for="item in visualSummaryData" :key="item.label" class="vs-item">
                  <span>{{ item.label }}</span>
                  <b>{{ item.value }}</b>
                </div>
              </div>

              <h3>六线脚本</h3>
              <ul class="six">
                <li v-for="line in sixLines" :key="line.label">
                  <span class="tag">{{ line.label }}</span>
                  <span>{{ line.value }}</span>
                </li>
                <li v-if="!sixLines.length" class="muted">模型未返回六线结构</li>
              </ul>

              <h3>分镜核对 <em v-if="frameNotes.length">{{ frameNotes.length }} 格</em></h3>
              <div class="shots">
                <article v-for="note in frameNotes" :key="note.index" class="shot">
                  <img v-if="frames[note.index]" :src="frames[note.index].image" alt="" />
                  <div class="shot-body">
                    <div class="shot-head">
                      <strong>S{{ Number(note.index) + 1 }}</strong>
                      <span class="emo">{{ note.emotionLine || "—" }}</span>
                    </div>
                    <p>{{ note.visualDescription || "—" }}</p>
                    <p v-if="note.evidence" class="ev">证据：{{ note.evidence }}</p>
                    <div v-if="note.reusableStructure || note.adaptedSpeech" class="shot-extra">
                      <p v-if="note.sourceRole"><b>原片作用</b>{{ note.sourceRole }}</p>
                      <p v-if="note.reusableStructure"><b>可复用结构</b>{{ note.reusableStructure }}</p>
                      <p v-if="note.productReplacement"><b>替换为</b>{{ note.productReplacement }}</p>
                      <p v-if="note.adaptedSpeech"><b>新口播</b>{{ note.adaptedSpeech }}</p>
                      <p v-if="note.shootingInstruction"><b>拍摄指令</b>{{ note.shootingInstruction }}</p>
                      <p v-if="note.noCopy"><b>不可照抄</b>{{ note.noCopy }}</p>
                    </div>
                  </div>
                </article>
                <div v-if="!frameNotes.length" class="muted">模型未返回分镜</div>
              </div>

              <h3>修改思路</h3>
              <p class="body">{{ analysis.editIdea || "—" }}</p>

              <template v-if="analysis.reviewEditIdea">
                <h3>剪映剪辑脚本</h3>
                <pre class="script">{{ analysis.reviewEditIdea }}</pre>
              </template>

              <div v-if="analysis.crossCheck" class="cross">
                交叉核对 {{ analysis.crossCheck.score ?? "-" }} 分 · {{ analysis.crossCheck.note || "" }}
              </div>
            </template>
          </div>

          <div v-else-if="tab === 'local'" class="report">
            <div v-if="!localRows.length" class="empty small">先转写，才会生成本地初判</div>
            <table v-else class="kv">
              <tbody>
                <tr v-for="row in localRows" :key="row[0]">
                  <th>{{ row[0] }}</th>
                  <td>{{ row[1] }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <pre v-else class="log">{{ log || "暂无日志" }}</pre>
        </div>
      </section>
    </main>

    <!-- ================= 分镜拉片 ================= -->
    <main v-else-if="mode === 'storyboard'" class="sb-main">
      <div class="sb-head-bar">
        <div class="sb-title">
          分镜拉片
          <em v-if="filteredColumns.length">
            {{ filteredColumns.length }}<template v-if="tagFilter"> / {{ storyboardColumns.length }}</template> 个分镜
          </em>
          <em v-if="meta.duration">· {{ formatTime(meta.duration) }}</em>
        </div>
        <div class="sb-right">
          <div class="sb-legend">
            <span class="dot d1">3.99</span>
            <span class="dot d2">3.2</span>
            <span class="dot d3">3.1</span>
          </div>
          <button class="mini-btn" :disabled="!sourceId || exporting" @click="doExportAll">
            {{ exporting ? "导出中…" : "导出全部片段" }}
          </button>
        </div>
      </div>

      <div v-if="hasTags" class="tag-bar">
        <button :class="['tag-chip', !tagFilter && 'active']" @click="tagFilter = ''">
          全部 <i>{{ storyboardColumns.length }}</i>
        </button>
        <button
          v-for="tag in STRUCTURE_TAGS"
          :key="tag.key"
          :class="['tag-chip', tagFilter === tag.key && 'active']"
          :style="{ '--tag': tag.color }"
          :disabled="!tagStats[tag.key]"
          @click="tagFilter = tagFilter === tag.key ? '' : tag.key"
        >
          <span class="tag-dot"></span>{{ tag.key }} <i>{{ tagStats[tag.key] || 0 }}</i>
        </button>
      </div>

      <div v-if="!storyboardColumns.length" class="empty small">
        还没有分镜。先去「拉片分析」上传视频并抽帧。
      </div>

      <div v-else class="sb-scroll">
        <div class="sb-table" :style="{ minWidth: 160 + filteredColumns.length * 240 + 'px' }">
          <div class="sb-row sb-headrow">
            <div class="sb-label">分镜</div>
            <div v-for="col in filteredColumns" :key="'h' + col.index" class="sb-cell sb-headcell">
              <span>分镜{{ col.index + 1 }}</span>
              <span
                v-if="col.structureTag"
                class="sb-tag"
                :style="{ '--tag': tagColor(col.structureTag) }"
              >
                {{ col.structureTag }}
              </span>
            </div>
          </div>

          <div v-for="row in STORYBOARD_ROWS" :key="row.key" class="sb-row">
            <div class="sb-label">{{ row.label }}</div>
            <div v-for="col in filteredColumns" :key="row.key + col.index" class="sb-cell">
              <template v-if="row.key === 'visual'">
                <video
                  v-if="col.clipUrl"
                  :src="col.clipUrl"
                  :poster="col.image"
                  preload="none"
                  controls
                  playsinline
                  class="sb-video"
                ></video>
                <img
                  v-else-if="col.image"
                  :src="col.image"
                  alt=""
                  class="sb-thumb"
                  title="点击看大图"
                  @click="openLightbox(col.index)"
                />
                <div class="sb-meta">分镜{{ col.index + 1 }} · {{ col.timeRange }}</div>
                <p class="sb-text">{{ col.visual }}</p>
                <div class="sb-actions">
                  <button class="mini" @click="openLightbox(col.index)">看大图</button>
                  <button class="mini" @click="downloadFrame(col)">下载</button>
                </div>
              </template>
              <template v-else-if="row.key === 'layer'">
                <p class="sb-text">{{ col.layer }}</p>
                <p class="sb-muted">{{ col.perspective }}</p>
              </template>
              <template v-else-if="row.key === 'role'">
                <p class="sb-text">{{ col.role }}</p>
              </template>
              <template v-else-if="row.key === 'pain'">
                <p class="sb-text">{{ col.pain }}</p>
              </template>
              <template v-else-if="row.key === 'adjust'">
                <label class="sb-check"><input type="checkbox" /><span>需调整</span></label>
              </template>
              <template v-else>
                <p class="sb-muted">画面：{{ col.visual.slice(0, 28) }}</p>
                <p class="sb-text">口播：{{ col.speech }}</p>
              </template>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- ================= 投放复盘 ================= -->
    <main v-else-if="mode === 'review'" class="grid">
      <section class="col left">
        <div class="card">
          <h2>千川后台截图 <em>{{ reviewReady }}/4</em></h2>
          <div class="slots">
            <div v-for="slot in SHOT_SLOTS" :key="slot.key" class="slot">
              <label class="slot-drop">
                <input type="file" accept="image/*" @change="pickScreenshot(slot.key, $event)" />
                <img v-if="reviewSlots[slot.key]" :src="reviewSlots[slot.key].image" alt="" />
                <span v-else>{{ slot.title }}</span>
              </label>
              <button v-if="reviewSlots[slot.key]" class="mini" @click="clearScreenshot(slot.key)">移除</button>
              <small v-if="reviewSlots[slot.key]">{{ slot.title }}</small>
            </div>
          </div>
          <p class="hint">按顺序对应：数据总览 / 点赞 / 流失 / 点击。缺一两张也能跑，模型会标注证据不足。</p>
        </div>

        <div class="card">
          <h2>执行</h2>
          <button class="wide primary" :disabled="!canReview" @click="doReview">
            {{ busy.review ? "复盘中…" : "开始投放复盘" }}
          </button>
          <p class="hint">
            复盘会结合当前的拉片结论。
            <template v-if="!localAnalysis">当前还没有拉片结果，建议先去「拉片分析」跑一遍。</template>
          </p>
        </div>
      </section>

      <section class="col mid">
        <div class="card">
          <h2>截图预览</h2>
          <div class="review-shots">
            <figure v-for="slot in SHOT_SLOTS" :key="slot.key">
              <img v-if="reviewSlots[slot.key]" :src="reviewSlots[slot.key].image" alt="" />
              <div v-else class="ph">{{ slot.title }}</div>
              <figcaption>{{ slot.title }}</figcaption>
            </figure>
          </div>
        </div>

        <div class="card">
          <h2>关联的拉片结论</h2>
          <div v-if="!localAnalysis" class="empty small">还没有拉片结果</div>
          <table v-else class="kv">
            <tbody>
              <tr v-for="row in localRows.slice(0, 6)" :key="row[0]">
                <th>{{ row[0] }}</th>
                <td>{{ row[1] }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="col right">
        <div class="card grow">
          <h2>复盘报告</h2>
          <div class="report">
            <div v-if="!review" class="empty small">上传截图后点「开始投放复盘」</div>
            <template v-else>
              <div class="verdict" :data-v="review.verdict">
                {{ review.verdict || "—" }}
              </div>
              <p class="body">{{ review.summary || "—" }}</p>

              <h3>四张截图的证据链</h3>
              <div class="findings">
                <article v-for="item in reviewFindings" :key="item.key" class="finding">
                  <strong>{{ item.title || item.key }}</strong>
                  <ul>
                    <li v-for="(obs, i) in item.observations || []" :key="i">{{ obs }}</li>
                  </ul>
                  <p class="conc">{{ item.conclusion }}</p>
                  <p v-for="(act, i) in item.actions || []" :key="'a' + i" class="act">→ {{ act }}</p>
                </article>
                <div v-if="!reviewFindings.length" class="muted">模型未返回截图分析</div>
              </div>

              <h3>改进动作</h3>
              <ol class="recs">
                <li v-for="(item, i) in reviewActions" :key="i">
                  <span class="pri" :data-p="item.priority">{{ item.priority || "—" }}</span>
                  <div>
                    <b v-if="item.timeRange">{{ item.timeRange }}</b>
                    <p>{{ item.problem }}</p>
                    <p class="act">→ {{ item.action }}</p>
                    <p v-if="item.evidence" class="ev">证据：{{ item.evidence }}</p>
                  </div>
                </li>
                <div v-if="!reviewActions.length" class="muted">模型未返回改进建议</div>
              </ol>
            </template>
          </div>
        </div>
      </section>
    </main>

    <!-- ================= 终局对比 ================= -->
    <main v-else-if="mode === 'compare'" class="grid">
      <section class="col left">
        <div class="card">
          <h2>对标视频</h2>
          <div class="meta-line">{{ file ? file.name : "未选择（先在「拉片分析」上传）" }}</div>
          <div class="meta-line muted">{{ frames.length }} 张分镜</div>
        </div>

        <div class="card">
          <h2>成品视频</h2>
          <label class="upload">
            <input type="file" accept="video/*" @change="pickFinalFile" />
            <span>{{ finalFile ? finalFile.name : "点击选择成品视频" }}</span>
          </label>
          <div v-if="finalMeta.duration" class="meta">
            {{ formatTime(finalMeta.duration) }} · {{ finalFrames.length }} 张分镜
          </div>
          <button class="wide" :disabled="!finalFile || busy.transcribe" @click="doTranscribeFinal">
            {{ busy.transcribe ? "转写中…" : "转写成品音频（可选）" }}
          </button>
        </div>

        <div class="card">
          <h2>执行</h2>
          <label class="field">
            <span>对比模式</span>
            <select v-model="compareMode">
              <option value="deep">API 深度 1:1 对比（带画面）</option>
              <option value="text">仅文本对比（省 token）</option>
            </select>
          </label>
          <button class="wide primary" :disabled="!canCompare" @click="doCompare">
            {{ busy.compare ? "对比中…" : "开始 4 段对比" }}
          </button>
          <p class="hint">
            需要两边都有分镜。<template v-if="!frames.length">先去「拉片分析」上传对标视频。</template>
            建议先转写成品音频，否则音频项会判为证据不足。
          </p>
        </div>
      </section>

      <section class="col mid">
        <div class="card">
          <h2>4 段对比 <em>按营销结构</em></h2>
          <div class="seg-list">
            <article v-for="seg in compareSegmentViews" :key="seg.key" class="seg-card">
              <div class="seg-head">
                <strong>{{ seg.title }}</strong>
                <span v-if="seg.benchmarkTime" class="seg-time">
                  对标 {{ seg.benchmarkTime }}
                  <template v-if="seg.finalTime"> · 成品 {{ seg.finalTime }}</template>
                </span>
              </div>
              <p class="seg-hint">{{ seg.hint }}</p>
              <label class="field">
                <span>对标怎么做的</span>
                <textarea
                  v-model="compareSegments[seg.key].benchmark"
                  rows="2"
                  :placeholder="seg.benchmarkPh"
                ></textarea>
              </label>
              <label class="field">
                <span>成品怎么做的</span>
                <textarea
                  v-model="compareSegments[seg.key].final"
                  rows="2"
                  :placeholder="seg.finalPh"
                ></textarea>
              </label>
            </article>
          </div>
          <p class="hint">填得越具体，模型判断越准；留空则完全靠它自己读画面。</p>
        </div>
      </section>

      <section class="col right">
        <div class="card grow">
          <h2>对比报告</h2>
          <div class="report">
            <div v-if="!compare" class="empty small">两边都准备好后点「开始 1:1 复刻对比」</div>
            <template v-else>
              <div class="score-row">
                <div class="score">{{ compare.score ?? "—" }}</div>
                <div>
                  <p class="body">{{ compare.summary || "—" }}</p>
                  <span v-if="compare.apiCompareMode" class="badge">画面模式：{{ compare.apiCompareMode }}</span>
                </div>
              </div>
              <p v-if="compare.apiCompareWarning" class="warn">{{ compare.apiCompareWarning }}</p>

              <h3>逐分镜对比 <em v-if="compareShots.length">{{ compareShots.length }} 段</em></h3>
              <div class="shots">
                <article v-for="(shot, i) in compareShots" :key="i" class="shot-block">
                  <div class="shot-head">
                    <strong>{{ shot.title || `第 ${i + 1} 段` }}</strong>
                    <span class="emo">{{ shot.score ?? "-" }} 分</span>
                  </div>
                  <div class="times">
                    <span>对标 {{ shot.benchmarkTime || "—" }}</span>
                    <span>成品 {{ shot.finalTime || "—" }}</span>
                  </div>
                  <p class="cmp">{{ shot.compare || "—" }}</p>
                  <p class="act">→ {{ shot.action || "—" }}</p>
                </article>
                <div v-if="!compareShots.length" class="muted">模型未返回分镜对比</div>
              </div>

              <h3>十三项维度</h3>
              <table class="kv rows-table">
                <tbody>
                  <tr v-for="(row, i) in compareRows" :key="i">
                    <th>
                      {{ row.title }}
                      <span class="row-score">{{ row.score ?? "-" }}</span>
                    </th>
                    <td>
                      <p class="b">对标：{{ row.benchmarkDetail || "—" }}</p>
                      <p class="f">成品：{{ row.finalDetail || "—" }}</p>
                      <p class="cmp">{{ row.compare || "—" }}</p>
                      <p class="act">→ {{ row.action || "—" }}</p>
                    </td>
                  </tr>
                  <tr v-if="!compareRows.length">
                    <td class="muted">模型未返回维度表</td>
                  </tr>
                </tbody>
              </table>

              <h3>修改清单</h3>
              <ol class="recs">
                <li v-for="(item, i) in compareSuggestions" :key="i">
                  <span class="pri" :data-p="item.priority">{{ item.priority || "—" }}</span>
                  <div>
                    <b>{{ item.title }}</b>
                    <p class="act">→ {{ item.edit }}</p>
                    <p v-if="item.check" class="ev">验收：{{ item.check }}</p>
                  </div>
                </li>
                <div v-if="!compareSuggestions.length" class="muted">模型未返回修改清单</div>
              </ol>
            </template>
          </div>
        </div>
      </section>
    </main>

    <!-- ================= 逐镜裂变 ================= -->
    <main v-else-if="mode === 'fission'" class="grid">
      <section class="col left">
        <div class="card">
          <h2>裂变前置</h2>
          <div class="meta-line">
            {{ analysis ? `已拉片 · ${frames.length} 个分镜` : "还没有拉片结果" }}
          </div>
          <p class="hint">裂变基于「拉片分析」的分镜槽位工作，没跑过拉片就先回第一个模式。</p>
        </div>

        <div class="card">
          <h2>我的产品</h2>
          <label class="field">
            <span>产品名</span>
            <input v-model="fissionProfile.productName" placeholder="例：橙言牙套收纳盒" />
          </label>
          <label class="field">
            <span>品类</span>
            <input v-model="fissionProfile.category" placeholder="例：口腔护理 / 正畸周边" />
          </label>
          <label class="field">
            <span>目标人群</span>
            <input v-model="fissionProfile.audience" placeholder="例：戴保持器的上班族" />
          </label>
          <label class="field">
            <span>裂变目标</span>
            <select v-model="fissionProfile.goal">
              <option>综合提升</option>
              <option>提升3秒留存</option>
              <option>提升完播率</option>
              <option>提升商品点击</option>
              <option>提升转化成交</option>
            </select>
          </label>
          <label class="field">
            <span>使用场景</span>
            <input v-model="fissionProfile.scene" placeholder="例：办公室、出差、饭后清洗" />
          </label>
          <label class="field">
            <span>核心痛点</span>
            <input v-model="fissionProfile.pain" placeholder="例：忘带、清洗麻烦、有异味" />
          </label>
          <label class="field">
            <span>优惠信息</span>
            <input v-model="fissionProfile.offer" placeholder="未确定可留空" />
          </label>
          <label class="field">
            <span>禁止项</span>
            <input v-model="fissionProfile.forbidden" placeholder="例：不能承诺疗效、不能写销量第一" />
          </label>
          <label class="field">
            <span>产品卖点</span>
            <textarea
              v-model="fissionProfile.sellingPoints"
              rows="3"
              placeholder="每行一个，只填可对外表达的真实信息"
            ></textarea>
          </label>
          <label class="field">
            <span>证据材料</span>
            <textarea
              v-model="fissionProfile.proof"
              rows="3"
              placeholder="例：配料表、检测报告、使用演示、真实评价；没有就留空"
            ></textarea>
          </label>
          <p class="hint">禁止项和证据是防编造的关键：填了模型就不敢瞎写功效和销量。</p>
        </div>

        <div class="card">
          <h2>执行</h2>
          <button class="wide primary" :disabled="!canFission" @click="doFission">
            {{ busy.fission ? "裂变中，输出较长…" : "生成槽位裂变矩阵" }}
          </button>
          <p class="hint">每个分镜产出 3 条口播、3-5 条画面、2-3 条字幕，附组合规则与验证指标。</p>
        </div>
      </section>

      <section class="col mid">
        <div class="card">
          <h2>分镜槽位 <em v-if="fissionShots.length">{{ fissionShots.length }}</em></h2>
          <div class="slot-list">
            <article v-for="shot in fissionShots" :key="shot.shotId" class="fis-shot">
              <div class="fis-head">
                <strong>S{{ shot.shotIndex }} · {{ shot.slotRoleLabel }}</strong>
                <span class="fis-tag" :data-s="shot.strategy">{{ shot.strategyLabel }}</span>
              </div>
              <p class="fis-meta">
                {{ formatTime(shot.start) }}-{{ formatTime(shot.end) }} · 优先级 {{ shot.priority }}
              </p>
              <p v-if="shot.validationMetric" class="fis-metric">验证：{{ shot.validationMetric }}</p>
              <p v-if="shot.evidenceWarning" class="warn-inline">{{ shot.evidenceWarning }}</p>
            </article>
            <div v-if="!fissionShots.length" class="empty small">
              {{ analysis ? "点左侧「生成槽位裂变矩阵」" : "先去「拉片分析」完成一次 AI 拉片" }}
            </div>
          </div>
        </div>
      </section>

      <section class="col right">
        <div class="card grow">
          <h2>裂变矩阵</h2>
          <div class="report">
            <div v-if="!fission" class="empty small">还没有裂变结果</div>
            <template v-else>
              <div class="badges">
                <span class="badge">
                  {{ fission.globalStrategy?.logicType === "weak_logic" ? "弱逻辑·可乱序" : "强逻辑·锁顺序" }}
                </span>
                <span class="badge">{{ fission.globalStrategy?.targetAudience || "人群待补" }}</span>
                <span class="badge">{{ fission.globalStrategy?.coreSellingPoint || "卖点待补" }}</span>
              </div>

              <div class="strategy-box">
                <div><span>核心痛点</span>{{ fission.globalStrategy?.corePain || "—" }}</div>
                <div><span>证明方式</span>{{ fission.globalStrategy?.proofMethod || "—" }}</div>
                <div><span>转化目标</span>{{ fission.globalStrategy?.conversionGoal || "—" }}</div>
              </div>

              <div v-for="shot in fissionShots" :key="'d' + shot.shotId" class="fis-block">
                <div class="fis-head">
                  <strong>S{{ shot.shotIndex }} · {{ shot.slotRoleLabel }}</strong>
                  <span class="fis-tag" :data-s="shot.strategy">{{ shot.strategyLabel }}</span>
                </div>

                <div v-if="shot.stableSkeleton.length" class="fis-part">
                  <h4>稳定骨架</h4>
                  <p v-for="(item, i) in shot.stableSkeleton" :key="'sk' + i">{{ item }}</p>
                </div>

                <div v-if="shot.voiceoverPool.length" class="fis-part">
                  <h4>口播池</h4>
                  <p v-for="vo in shot.voiceoverPool" :key="vo.id">
                    <b>{{ vo.angle || vo.id }}</b>：{{ vo.text }}
                    <em v-if="vo.estimatedDuration">约 {{ vo.estimatedDuration }}s</em>
                  </p>
                </div>

                <div v-if="shot.visualPool.length" class="fis-part">
                  <h4>画面池</h4>
                  <p v-for="vis in shot.visualPool" :key="vis.id">
                    <b>{{ vis.shotScale || vis.id }}</b>：{{ vis.subject }} · {{ vis.action }}
                    <em v-if="vis.purpose">{{ vis.purpose }}</em>
                  </p>
                </div>

                <div v-if="shot.textPool.length" class="fis-part">
                  <h4>字幕池</h4>
                  <p v-for="t in shot.textPool" :key="t.id">
                    {{ t.text }}<em v-if="t.purpose">{{ t.purpose }}</em>
                  </p>
                </div>

                <div
                  v-if="shot.combinationRule && Object.keys(shot.combinationRule).length"
                  class="fis-part"
                >
                  <h4>组合规则</h4>
                  <p class="rule">
                    顺序锁定 {{ shot.combinationRule.orderLocked ? "是" : "否" }} · 口播随机
                    {{ shot.combinationRule.voiceoverRandomAllowed ? "允许" : "禁止" }} · 画面随机
                    {{ shot.combinationRule.visualRandomAllowed ? "允许" : "禁止" }} · 乱序混剪
                    {{ shot.combinationRule.unorderedMixAllowed ? "允许" : "禁止" }}
                  </p>
                  <p
                    v-for="(b, i) in shot.combinationRule.bindings || []"
                    :key="'bd' + i"
                    class="rule"
                  >
                    绑定：口播 {{ (b.voiceoverIds || []).join("/") }} → 画面
                    {{ (b.requiredVisualIds || []).join("/") }}
                    <em v-if="b.reason">{{ b.reason }}</em>
                  </p>
                  <p v-if="shot.combinationRule.exclusions && shot.combinationRule.exclusions.length" class="rule">
                    禁混：{{ shot.combinationRule.exclusions.join("；") }}
                  </p>
                </div>

                <p v-if="shot.reason" class="fis-reason">判断依据：{{ shot.reason }}</p>
              </div>
            </template>
          </div>
        </div>
      </section>
    </main>

    <!-- ================= 历史记录 ================= -->
    <main v-else class="grid history-grid">
      <section class="col">
        <div class="card grow">
          <div class="card-head">
            <h2>历史记录 <em>{{ historyRecords.length }} 条</em></h2>
            <div class="hi-tools">
              <label v-if="historyRecords.length" class="hi-check">
                <input type="checkbox" :checked="allHistorySelected" @change="toggleAllHistory" />
                <span>全选</span>
              </label>
              <button
                class="mini-btn"
                :disabled="!historyRecords.length"
                @click="exportSelectedHistory"
              >
                导出 {{ selectedHistory.length || historyRecords.length }} 条 CSV
              </button>
              <button class="mini-btn" @click="loadHistoryList">
                {{ historyLoading ? "读取中…" : "刷新" }}
              </button>
            </div>
          </div>
          <div v-if="historyRecords.length" class="cat-bar">
            <button :class="['cat-chip', !historyFilter && 'active']" @click="historyFilter = ''">
              全部 <i>{{ historyRecords.length }}</i>
            </button>
            <button
              v-for="cat in HISTORY_CATEGORIES"
              :key="cat"
              :class="['cat-chip', historyFilter === cat && 'active']"
              :disabled="!categoryStats[cat]"
              @click="historyFilter = historyFilter === cat ? '' : cat"
            >
              {{ cat }} <i>{{ categoryStats[cat] || 0 }}</i>
            </button>
          </div>
          <div class="report">
            <div v-if="!historyRecords.length" class="empty small">
              还没有历史记录。每跑一次 AI 拉片会自动存档（含分镜图）。
            </div>
            <div v-else-if="!filteredHistory.length" class="empty small">
              这个分类下还没有记录。
            </div>
            <div class="history-list">
              <article v-for="rec in filteredHistory" :key="rec.id" class="history-item">
                <label class="hi-check">
                  <input
                    type="checkbox"
                    :checked="selectedHistory.includes(rec.id)"
                    @change="toggleHistory(rec.id)"
                  />
                </label>
                <img v-if="rec.thumb" :src="rec.thumb" alt="" />
                <div v-else class="ph">无图</div>
                <div class="hi-body">
                  <div class="hi-title">{{ rec.fileName || "未命名素材" }}</div>
                  <div class="hi-meta">
                    {{ formatTime(rec.duration) }} · {{ rec.frameCount }} 镜 ·
                    {{ new Date(rec.createdAt).toLocaleString("zh-CN", { hour12: false }) }}
                  </div>
                  <div class="badges">
                    <span v-if="rec.layer" class="badge">{{ rec.layer }}</span>
                    <span v-if="rec.opening" class="badge">{{ rec.opening }}</span>
                    <span v-if="rec.product" class="badge">{{ rec.product }}</span>
                  </div>
                </div>
                <div class="hi-actions">
                  <select
                    class="cat-select"
                    :value="rec.category || '未分类'"
                    @change="setCategory(rec, $event.target.value)"
                  >
                    <option v-for="c in HISTORY_CATEGORIES" :key="c" :value="c">{{ c }}</option>
                  </select>
                  <button class="primary" @click="openRecord(rec.id)">载入</button>
                  <button class="mini" @click="removeRecord(rec.id)">删除</button>
                </div>
              </article>
            </div>
          </div>
        </div>
      </section>
    </main>

    <!-- 分镜大图预览 -->
    <div v-if="lightbox.open && lightboxFrame" class="mask lightbox-mask" @click.self="closeLightbox">
      <div class="lb-stage">
        <button v-if="lightboxList.length > 1" class="lb-nav prev" @click.stop="stepLightbox(-1)">‹</button>
        <figure class="lb-figure">
          <video
            v-if="lightboxClipUrl"
            :key="lightboxClipUrl"
            :src="lightboxClipUrl"
            :poster="lightboxFrame.image"
            controls
            autoplay
            playsinline
            class="lb-video"
          ></video>
          <img v-else :src="lightboxFrame.image" alt="" />
          <figcaption>
            <strong>
              {{ lightbox.source === "final" ? "成品" : "对标" }} · 分镜{{ lightbox.index + 1 }}
            </strong>
            <span>{{ formatTime(lightboxFrame.start) }} - {{ formatTime(lightboxFrame.end) }}</span>
            <em>{{ lightbox.index + 1 }} / {{ lightboxList.length }}</em>
          </figcaption>
        </figure>
        <button v-if="lightboxList.length > 1" class="lb-nav next" @click.stop="stepLightbox(1)">›</button>
      </div>
      <div class="lb-tools">
        <button
          v-if="lightbox.source === 'frames'"
          @click="downloadFrame({ index: lightbox.index })"
        >
          下载这一镜片段
        </button>
        <button @click="closeLightbox">关闭（Esc）</button>
      </div>
    </div>

    <div v-if="settingsOpen" class="mask" @click.self="settingsOpen = false">
      <div class="modal">
        <header>
          <h2>模型与识别设置</h2>
          <button class="x" @click="settingsOpen = false">关闭</button>
        </header>

        <label class="f">
          <span>接口地址 Base URL</span>
          <input v-model="settingsForm.baseUrl" placeholder="https://api.openai.com 或任意兼容中转地址" />
        </label>

        <label class="f">
          <span>API Key<em>{{ health?.settings?.apiKeyHint || "未设置" }}</em></span>
          <input v-model="settingsForm.apiKey" type="password" placeholder="留空表示不修改" />
        </label>

        <label class="f">
          <span>文本模型名<em>裂变的口播/画面文案用，便宜的就够</em></span>
          <input v-model="settingsForm.model" placeholder="例：deepseek-chat / qwen-plus" />
        </label>

        <div class="settings-split">视觉模型 · 拉片 / 复盘 / 对比要看图，必须支持图片输入</div>
        <div class="presets">
          <span>快速填充</span>
          <button @click="applyVisionPreset('qwen')">通义 VL</button>
          <button @click="applyVisionPreset('zhipu')">智谱 GLM-4V</button>
          <button @click="applyVisionPreset('ark')">豆包 Vision</button>
        </div>
        <label class="f">
          <span>视觉服务商地址<em>留空则沿用上面的 Base URL</em></span>
          <input v-model="settingsForm.visionBaseUrl" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" />
        </label>
        <label class="f">
          <span>视觉模型 Key<em>留空则沿用上面的 Key</em></span>
          <input v-model="settingsForm.visionApiKey" type="password" placeholder="不同服务商时才需要填" />
        </label>
        <label class="f">
          <span>视觉模型名</span>
          <input v-model="settingsForm.visionModel" placeholder="例：qwen3-vl-plus / glm-4v-plus" />
        </label>

        <label class="f">
          <span>本地转写模型</span>
          <select v-model="settingsForm.transcribeModel">
            <option value="ggml-small.bin">small（487MB，默认）</option>
            <option value="ggml-medium.bin">medium（1.5GB，更准，需手动放入 vendor）</option>
            <option value="ggml-base.bin">base（142MB，最快，精度低）</option>
          </select>
        </label>

        <label class="f">
          <span>行业术语表<em>顿号或换行分隔，喂给转写引擎纠正专名</em></span>
          <textarea
            v-model="settingsForm.glossaryText"
            rows="3"
            placeholder="牙套、保持器、升降沥水、密封圈、摘取器"
          />
        </label>

        <div class="presets">
          <span>快速填充</span>
          <button @click="settingsForm.baseUrl = 'https://api.openai.com'">OpenAI</button>
          <button
            @click="
              settingsForm.baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
              settingsForm.model = 'qwen-plus';
            "
          >
            通义千问
          </button>
          <button
            @click="
              settingsForm.baseUrl = 'https://ark.cn-beijing.volces.com/api/v3';
              settingsForm.model = '';
            "
          >
            火山豆包
          </button>
          <button
            @click="
              settingsForm.baseUrl = 'https://open.bigmodel.cn/api/paas/v4';
              settingsForm.model = 'glm-4v-plus';
            "
          >
            智谱
          </button>
        </div>

        <p v-if="testResult" class="test-out">{{ testResult }}</p>

        <footer>
          <button :disabled="testing" @click="testApi">{{ testing ? "测试中…" : "测试连通" }}</button>
          <button class="primary" @click="saveSettings">保存</button>
        </footer>
        <p class="hint">
          测试连通读取的是「已保存」的配置，改完先保存再测。视觉模型必须支持图片输入，纯文本模型跑不了拉片。
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.topbar {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0 18px;
  height: 54px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
  flex-shrink: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
}

.brand h1 {
  font-size: 14px;
  font-weight: 500;
  margin: 0;
  white-space: nowrap;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
}

.modes {
  display: flex;
  gap: 4px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 3px;
}

.modes button {
  background: transparent;
  border: none;
  padding: 5px 13px;
  font-size: 12px;
  color: var(--muted);
  border-radius: 6px;
}

.modes button.on {
  background: var(--panel-2);
  color: var(--text);
}

.status {
  flex: 1;
  font-size: 12px;
  color: var(--muted);
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status[data-tone="ok"] {
  color: var(--ok);
}
.status[data-tone="running"] {
  color: var(--accent);
}
.status[data-tone="error"] {
  color: var(--danger);
}

.elapsed {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: 10px;
  background: rgba(79, 140, 255, 0.15);
  color: var(--accent);
  font-size: 10.5px;
}

.health {
  display: flex;
  gap: 6px;
}

.pill {
  font-size: 11px;
  padding: 3px 9px;
  border-radius: 20px;
  border: 1px solid var(--border);
  color: var(--muted);
  white-space: nowrap;
}

.pill.ok {
  color: var(--ok);
  border-color: rgba(53, 196, 138, 0.35);
}

.pill.bad {
  color: var(--warn);
  border-color: rgba(240, 164, 55, 0.35);
}

.grid {
  flex: 1;
  display: grid;
  grid-template-columns: 300px minmax(360px, 1fr) minmax(400px, 1.05fr);
  gap: 14px;
  padding: 14px;
  overflow: hidden;
}

.col {
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  min-height: 0;
}

.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
}

.card.grow {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.card h2 {
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  margin: 0 0 10px;
  display: flex;
  justify-content: space-between;
}

.card h2 em,
.card h3 em {
  font-style: normal;
  color: var(--muted);
  font-weight: 400;
  font-size: 11px;
}

.upload {
  display: block;
  border: 1px dashed #333a47;
  border-radius: 8px;
  padding: 16px 10px;
  text-align: center;
  cursor: pointer;
  color: var(--muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upload:hover {
  border-color: var(--accent);
  color: var(--text);
}

.upload input {
  display: none;
}

.meta {
  margin-top: 8px;
  font-size: 11px;
  color: var(--muted);
}

.meta-line {
  font-size: 12px;
  color: #c3c9d6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta-line.muted {
  color: var(--muted);
  margin-top: 4px;
  font-size: 11px;
}

.field {
  display: block;
  margin-bottom: 10px;
}

.field span {
  display: block;
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 4px;
}

button.wide {
  width: 100%;
  margin-top: 8px;
}

button.mini {
  width: 100%;
  padding: 3px;
  font-size: 10px;
  margin-top: 4px;
  color: var(--muted);
}

.hint {
  font-size: 11px;
  color: var(--muted);
  margin: 10px 0 0;
  line-height: 1.5;
}

.video-card {
  position: relative;
  padding: 0;
  overflow: hidden;
  background: #000;
}

.video-card video {
  width: 100%;
  max-height: 300px;
  display: block;
}

.empty {
  padding: 26px 12px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
}

.video-card .empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
}

.empty.small {
  padding: 18px 8px;
}

.strip {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 4px;
}

.strip figure {
  margin: 0;
  flex: 0 0 auto;
  cursor: zoom-in;
}

.strip figure:hover img {
  border-color: var(--accent);
}

.strip img {
  width: 80px;
  height: 140px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--border);
  display: block;
}

.strip figcaption {
  font-size: 10px;
  color: var(--muted);
  text-align: center;
  margin-top: 3px;
}

.tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 10px;
}

.tabs button {
  background: transparent;
  border: none;
  color: var(--muted);
  padding: 4px 10px;
  font-size: 12px;
}

.tabs button.on {
  color: var(--text);
  background: var(--panel-2);
}

.report {
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.badge {
  font-size: 11px;
  padding: 3px 9px;
  border-radius: 20px;
  background: rgba(79, 140, 255, 0.12);
  color: #9ec0ff;
  border: 1px solid rgba(79, 140, 255, 0.25);
}

.report h3 {
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  margin: 16px 0 8px;
  display: flex;
  justify-content: space-between;
}

.body {
  margin: 0;
  font-size: 12.5px;
  color: #c3c9d6;
}

.six {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.six li {
  display: flex;
  gap: 8px;
  font-size: 12px;
  background: var(--panel-2);
  border-radius: 6px;
  padding: 7px 9px;
  line-height: 1.55;
  color: #c3c9d6;
}

.tag {
  flex: 0 0 auto;
  color: #9ec0ff;
  font-size: 11px;
}

.shots {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.shot {
  display: flex;
  gap: 10px;
  background: var(--panel-2);
  border-radius: 8px;
  padding: 8px;
}

.shot img {
  width: 62px;
  height: 110px;
  object-fit: cover;
  border-radius: 5px;
  flex: 0 0 auto;
}

.shot-body {
  min-width: 0;
}

.shot-head {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 4px;
}

.shot p,
.shot-block p {
  margin: 0;
  font-size: 12px;
  color: #c3c9d6;
  line-height: 1.55;
}

.shot .ev,
.ev {
  margin-top: 4px;
  font-size: 11px;
  color: #7f8798;
}

.emo {
  color: #d7b98a;
  font-size: 11px;
}

.muted {
  color: var(--muted);
  font-size: 12px;
}

.cross {
  margin-top: 16px;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(53, 196, 138, 0.08);
  border: 1px solid rgba(53, 196, 138, 0.2);
  font-size: 11px;
  color: var(--ok);
}

.kv {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.kv th {
  text-align: left;
  font-weight: 400;
  color: var(--muted);
  width: 96px;
  padding: 6px 8px 6px 0;
  vertical-align: top;
}

.kv td {
  padding: 6px 0;
  color: #c3c9d6;
}

.kv tr + tr th,
.kv tr + tr td {
  border-top: 1px solid #21262f;
}

.log {
  flex: 1;
  overflow: auto;
  margin: 0;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.7;
  color: #98a1b3;
  white-space: pre-wrap;
  word-break: break-all;
}

/* 复盘 */
.slots {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.slot {
  min-width: 0;
}

.slot-drop {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 74px;
  border: 1px dashed #333a47;
  border-radius: 7px;
  cursor: pointer;
  overflow: hidden;
  font-size: 10px;
  color: var(--muted);
  text-align: center;
  padding: 4px;
}

.slot-drop:hover {
  border-color: var(--accent);
}

.slot-drop input {
  display: none;
}

.slot-drop img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.slot small {
  display: block;
  font-size: 10px;
  color: var(--muted);
  margin-top: 3px;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.review-shots {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.review-shots figure {
  margin: 0;
}

.review-shots img,
.review-shots .ph {
  width: 100%;
  height: 150px;
  object-fit: cover;
  border-radius: 7px;
  border: 1px solid var(--border);
  display: block;
}

.review-shots .ph {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 11px;
  background: var(--bg);
}

.review-shots figcaption {
  font-size: 10px;
  color: var(--muted);
  margin-top: 4px;
  text-align: center;
}

.verdict {
  display: inline-block;
  font-size: 13px;
  padding: 5px 14px;
  border-radius: 8px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  margin-bottom: 10px;
}

.verdict[data-v*="继续"] {
  color: var(--ok);
  border-color: rgba(53, 196, 138, 0.35);
}

.verdict[data-v*="停投"] {
  color: var(--danger);
  border-color: rgba(240, 106, 106, 0.35);
}

.findings {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.finding {
  background: var(--panel-2);
  border-radius: 8px;
  padding: 9px 11px;
}

.finding strong {
  font-size: 12px;
  color: #9ec0ff;
  font-weight: 500;
}

.finding ul {
  margin: 6px 0;
  padding-left: 16px;
  font-size: 11.5px;
  color: #b6bdcb;
  line-height: 1.6;
}

.finding .conc {
  margin: 4px 0 0;
  font-size: 12px;
  color: #c3c9d6;
}

.act {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--ok);
  line-height: 1.55;
}

.recs {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.recs li {
  display: flex;
  gap: 9px;
  background: var(--panel-2);
  border-radius: 8px;
  padding: 9px 11px;
  font-size: 12px;
  color: #c3c9d6;
}

.recs b {
  font-weight: 500;
  color: #e6e8ee;
  font-size: 12px;
}

.recs p {
  margin: 3px 0 0;
  line-height: 1.55;
}

.pri {
  flex: 0 0 auto;
  font-size: 10px;
  height: 18px;
  padding: 0 7px;
  border-radius: 5px;
  background: rgba(240, 164, 55, 0.15);
  color: var(--warn);
  line-height: 18px;
}

.pri[data-p="高"] {
  background: rgba(240, 106, 106, 0.15);
  color: var(--danger);
}

.pri[data-p="低"] {
  background: rgba(139, 147, 167, 0.15);
  color: var(--muted);
}

/* 对比 */
.pairs {
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}

.pair-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.pair-row figure {
  margin: 0;
}

.pair-row img,
.pair-row .ph {
  width: 100%;
  height: 170px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--border);
  display: block;
}

.pair-row .ph {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 11px;
  background: var(--bg);
}

.pair-row figcaption {
  font-size: 10px;
  color: var(--muted);
  margin-top: 3px;
  text-align: center;
}

.score-row {
  display: flex;
  gap: 14px;
  align-items: center;
  margin-bottom: 10px;
}

.score {
  font-size: 34px;
  font-weight: 500;
  color: var(--accent);
  line-height: 1;
  min-width: 64px;
}

.warn {
  font-size: 11px;
  color: var(--warn);
  background: rgba(240, 164, 55, 0.08);
  border: 1px solid rgba(240, 164, 55, 0.2);
  border-radius: 6px;
  padding: 7px 9px;
  margin: 0 0 10px;
  line-height: 1.55;
}

.shot-block {
  background: var(--panel-2);
  border-radius: 8px;
  padding: 9px 11px;
}

.times {
  display: flex;
  gap: 12px;
  font-size: 10.5px;
  color: var(--muted);
  margin: 4px 0 6px;
}

.cmp {
  color: #c3c9d6;
  font-size: 12px;
}

.rows-table th {
  width: 132px;
}

.row-score {
  display: inline-block;
  margin-left: 6px;
  font-size: 10px;
  color: var(--accent);
}

.rows-table td p {
  margin: 0 0 3px;
  line-height: 1.55;
}

.rows-table .b {
  color: #9ec0ff;
}

.rows-table .f {
  color: #c9b48a;
}

/* 设置弹层 */
.pill.clickable {
  cursor: pointer;
  font-family: inherit;
  background: transparent;
}

.pill.clickable:hover {
  border-color: #3a4252;
}

.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.modal {
  width: 520px;
  max-height: 88vh;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
}

.modal header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.modal h2 {
  font-size: 14px;
  font-weight: 500;
  margin: 0;
  color: var(--text);
}

.modal .x {
  background: transparent;
  border: none;
  color: var(--muted);
  font-size: 12px;
  padding: 2px 6px;
}

.f {
  display: block;
  margin-bottom: 12px;
}

.f span {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 5px;
}

.f em {
  font-style: normal;
  font-size: 10px;
  color: #6b7385;
}

.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin: 6px 0 12px;
}

.presets span {
  font-size: 11px;
  color: var(--muted);
}

.presets button {
  padding: 4px 10px;
  font-size: 11px;
  border-radius: 6px;
}

.test-out {
  font-size: 11.5px;
  color: var(--ok);
  background: rgba(53, 196, 138, 0.08);
  border: 1px solid rgba(53, 196, 138, 0.2);
  border-radius: 6px;
  padding: 7px 9px;
  margin: 0 0 10px;
  line-height: 1.5;
  word-break: break-all;
}

.modal footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.modal footer button {
  min-width: 88px;
}

/* 拉片报告新字段 */
.summary-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}

.sum-item {
  background: var(--panel-2);
  border-radius: 7px;
  padding: 7px 9px;
  min-width: 0;
}

.sum-label {
  display: block;
  font-size: 10px;
  color: var(--muted);
  margin-bottom: 3px;
}

.sum-value {
  display: block;
  font-size: 11.5px;
  color: #c3c9d6;
  line-height: 1.5;
  word-break: break-word;
}

.sum-value.pending {
  color: #6b7385;
}

.visual-summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 7px;
}

.vs-item {
  background: var(--panel-2);
  border-radius: 7px;
  padding: 8px 9px;
  text-align: center;
}

.vs-item span {
  display: block;
  font-size: 10px;
  color: var(--muted);
  margin-bottom: 4px;
}

.vs-item b {
  font-size: 12px;
  color: #e6e8ee;
  font-weight: 500;
}

.script {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--panel-2);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 11.5px;
  line-height: 1.75;
  color: #c3c9d6;
  font-family: inherit;
}

.shot-extra {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed #2b313d;
}

.shot-extra p {
  font-size: 11px;
  color: #9aa3b5;
  margin: 3px 0 0;
  line-height: 1.55;
}

.shot-extra b {
  color: #9ec0ff;
  font-weight: 500;
  margin-right: 5px;
}

/* 逐镜裂变 */
.slot-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
}

.fis-shot,
.fis-block {
  background: var(--panel-2);
  border-radius: 8px;
  padding: 9px 11px;
}

.fis-block {
  margin-bottom: 10px;
}

.fis-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.fis-head strong {
  font-weight: 500;
  color: #e6e8ee;
}

.fis-tag {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 20px;
  background: rgba(79, 140, 255, 0.14);
  color: #9ec0ff;
  white-space: nowrap;
}

.fis-tag[data-s="retain_original"] {
  background: rgba(139, 147, 167, 0.15);
  color: var(--muted);
}

.fis-tag[data-s="evidence_required"] {
  background: rgba(240, 106, 106, 0.14);
  color: var(--danger);
}

.fis-tag[data-s="material_expansion"] {
  background: rgba(240, 164, 55, 0.14);
  color: var(--warn);
}

.fis-meta {
  margin: 4px 0 0;
  font-size: 10.5px;
  color: var(--muted);
}

.fis-metric {
  margin: 3px 0 0;
  font-size: 11px;
  color: var(--ok);
}

.warn-inline {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--warn);
}

.fis-part {
  margin-top: 8px;
}

.fis-part h4 {
  font-size: 10.5px;
  font-weight: 400;
  color: var(--muted);
  margin: 0 0 3px;
}

.fis-part p {
  margin: 0 0 3px;
  font-size: 11.5px;
  color: #c3c9d6;
  line-height: 1.6;
}

.fis-part p b {
  color: #9ec0ff;
  font-weight: 500;
}

.fis-part p em {
  font-style: normal;
  color: #7f8798;
  font-size: 10.5px;
  margin-left: 4px;
}

.fis-part .rule {
  font-size: 11px;
  color: #9aa3b5;
}

.fis-reason {
  margin: 8px 0 0;
  padding-top: 6px;
  border-top: 1px dashed #2b313d;
  font-size: 11px;
  color: #7f8798;
}

.strategy-box {
  margin: 10px 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
  background: var(--panel-2);
  border-radius: 8px;
  padding: 9px 11px;
  font-size: 11.5px;
  color: #c3c9d6;
}

.strategy-box span {
  color: var(--muted);
  font-size: 10.5px;
  margin-right: 6px;
}

.export-out {
  margin-top: 8px;
  font-size: 11px;
  color: var(--ok);
  background: rgba(53, 196, 138, 0.08);
  border: 1px solid rgba(53, 196, 138, 0.2);
  border-radius: 6px;
  padding: 7px 9px;
  line-height: 1.5;
}

.export-dir {
  margin-top: 3px;
  color: var(--muted);
  font-size: 10px;
  word-break: break-all;
}

/* 历史记录 */
.history-grid {
  grid-template-columns: minmax(0, 1fr);
}

.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.card-head h2 {
  margin: 0;
}

.mini-btn {
  padding: 4px 11px;
  font-size: 11px;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.history-item {
  display: flex;
  gap: 12px;
  align-items: center;
  background: var(--panel-2);
  border-radius: 9px;
  padding: 10px;
}

.history-item img,
.history-item .ph {
  width: 62px;
  height: 110px;
  object-fit: cover;
  border-radius: 6px;
  flex: 0 0 auto;
}

.history-item .ph {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
  color: var(--muted);
  font-size: 10px;
}

.hi-body {
  flex: 1;
  min-width: 0;
}

.hi-title {
  font-size: 13px;
  color: #e6e8ee;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hi-meta {
  font-size: 11px;
  color: var(--muted);
  margin: 4px 0 6px;
}

.hi-actions {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 0 0 auto;
}

.hi-actions button {
  padding: 5px 14px;
  font-size: 11px;
}

.hi-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}

.settings-split {
  margin: 16px 0 10px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: #9ec0ff;
  letter-spacing: 0.3px;
}

/* 模型缺失提示 */
.setup-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 16px;
  background: rgba(240, 178, 106, 0.12);
  border-bottom: 1px solid rgba(240, 178, 106, 0.35);
  font-size: 12px;
  color: #e0c9a5;
}

.setup-banner strong {
  color: #f0b26a;
  font-weight: 500;
}

.setup-banner .mini {
  flex: 0 0 auto;
  padding: 5px 14px;
  font-size: 11px;
  margin-top: 0;
  background: rgba(240, 178, 106, 0.18);
  border: 1px solid rgba(240, 178, 106, 0.5);
  color: #f0b26a;
}

.model-alert {
  margin-top: 10px;
  padding: 10px 11px;
  border-radius: 8px;
  background: rgba(240, 178, 106, 0.1);
  border: 1px solid rgba(240, 178, 106, 0.35);
}

.model-alert strong {
  display: block;
  font-size: 11.5px;
  color: #f0b26a;
  font-weight: 500;
}

.model-alert p {
  margin: 5px 0 7px;
  font-size: 10.5px;
  line-height: 1.55;
  color: #c9b79a;
}

.model-alert code {
  display: block;
  margin-bottom: 8px;
  padding: 5px 7px;
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.3);
  font-size: 9.5px;
  color: #9aa3b2;
  word-break: break-all;
  line-height: 1.45;
}

.model-alert .mini {
  width: 100%;
  padding: 5px 0;
  font-size: 11px;
  margin-top: 0;
}

/* 分镜大图预览 */
.lightbox-mask {
  background: rgba(4, 6, 10, 0.93);
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 22px;
  z-index: 50;
}

.lb-stage {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  min-height: 0;
  width: 100%;
}

.lb-figure {
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  min-height: 0;
}

.lb-figure img {
  max-width: min(78vw, 900px);
  max-height: 70vh;
  object-fit: contain;
  border-radius: 10px;
  border: 1px solid #2a3040;
  background: #000;
}

.lb-video {
  max-width: min(78vw, 900px);
  max-height: 70vh;
  border-radius: 10px;
  border: 1px solid #2a3040;
  background: #000;
}

.lb-figure figcaption {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 12px;
  color: var(--muted);
}

.lb-figure figcaption strong {
  color: #e6e8ee;
  font-weight: 500;
}

.lb-figure figcaption em {
  font-style: normal;
  color: #6b7385;
}

.lb-nav {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  font-size: 24px;
  line-height: 1;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid #2a3040;
  color: #e6e8ee;
  flex: 0 0 auto;
  padding: 0;
}

.lb-nav:hover {
  background: rgba(255, 255, 255, 0.18);
}

.lb-tools {
  display: flex;
  justify-content: center;
  gap: 10px;
}

.lb-tools button {
  padding: 7px 18px;
  font-size: 12px;
  border-radius: 8px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  color: #e6e8ee;
  width: auto;
}

.hi-check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  flex: 0 0 auto;
}

.hi-check input[type="checkbox"] {
  width: 14px;
  height: 14px;
  padding: 0;
  margin: 0;
  border-radius: 3px;
  accent-color: var(--accent);
  cursor: pointer;
  flex: 0 0 auto;
}

.hi-check span {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}

/* 图5 四段对比 */
.seg-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.seg-card {
  background: var(--panel-2);
  border-radius: 9px;
  padding: 10px 11px;
}

.seg-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}

.seg-head strong {
  font-size: 12.5px;
  color: #e6e8ee;
  font-weight: 500;
}

.seg-time {
  font-size: 10px;
  color: var(--muted);
  white-space: nowrap;
}

.seg-hint {
  margin: 4px 0 8px;
  font-size: 10.5px;
  color: #7f8798;
  line-height: 1.5;
}

.seg-card .field {
  margin-bottom: 7px;
}

.seg-card .field:last-child {
  margin-bottom: 0;
}

/* 分镜拉片矩阵 */
.sb-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  overflow: hidden;
  min-height: 0;
}

.sb-head-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.sb-title {
  font-size: 14px;
  color: #e6e8ee;
}

.sb-title em {
  font-style: normal;
  font-size: 11px;
  color: var(--muted);
  margin-left: 8px;
}

.sb-legend {
  display: flex;
  gap: 6px;
}

.sb-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.dot {
  font-size: 10px;
  padding: 2px 9px;
  border-radius: 20px;
}

.dot.d1 {
  background: rgba(240, 106, 106, 0.15);
  color: #f06a6a;
}

.dot.d2 {
  background: rgba(240, 164, 55, 0.15);
  color: #f0a437;
}

.dot.d3 {
  background: rgba(79, 140, 255, 0.15);
  color: #9ec0ff;
}

.sb-scroll {
  flex: 1;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  min-height: 0;
}

.sb-table {
  display: flex;
  flex-direction: column;
}

/* 历史记录分类筛选 */
.cat-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.cat-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: transparent;
  color: #8f97a6;
  font-size: 11px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}

.cat-chip:hover:not(:disabled) {
  border-color: var(--accent);
  color: #dfe4ee;
}

.cat-chip.active {
  border-color: var(--accent);
  background: rgba(76, 141, 255, 0.16);
  color: #cfe0ff;
}

.cat-chip:disabled {
  opacity: 0.3;
  cursor: default;
}

.cat-chip i {
  font-style: normal;
  font-size: 10px;
  opacity: 0.7;
}

.cat-select {
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: #171a21;
  color: #9aa3b2;
  font-size: 11px;
  cursor: pointer;
  max-width: 92px;
}

.cat-select:hover {
  border-color: var(--accent);
}

/* 结构标签筛选条 */
.tag-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.015);
}

.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 11px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: transparent;
  color: #8f97a6;
  font-size: 11.5px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
}

.tag-chip:hover:not(:disabled) {
  border-color: var(--tag, var(--accent));
  color: #dfe4ee;
}

.tag-chip.active {
  border-color: var(--tag, var(--accent));
  background: color-mix(in srgb, var(--tag, var(--accent)) 16%, transparent);
  color: #f0f3f8;
}

.tag-chip:disabled {
  opacity: 0.3;
  cursor: default;
}

.tag-chip i {
  font-style: normal;
  font-size: 10px;
  opacity: 0.7;
}

.tag-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--tag, #5f6573);
  flex: 0 0 auto;
}

.sb-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-style: normal;
  font-weight: 400;
  line-height: 1.6;
  color: var(--tag);
  background: color-mix(in srgb, var(--tag) 18%, transparent);
  border: 0.5px solid color-mix(in srgb, var(--tag) 45%, transparent);
  vertical-align: middle;
  white-space: nowrap;
}

.sb-headcell {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 2px;
}

.sb-row {
  display: flex;
  border-bottom: 1px solid #21262f;
}

.sb-row:last-child {
  border-bottom: none;
}

.sb-label {
  flex: 0 0 120px;
  padding: 10px;
  font-size: 11px;
  color: var(--muted);
  background: var(--panel-2);
  position: sticky;
  left: 0;
  z-index: 2;
}

.sb-cell {
  flex: 0 0 240px;
  padding: 10px;
  border-left: 1px solid #21262f;
}

.sb-headrow .sb-cell {
  font-size: 12px;
  color: #e6e8ee;
  background: var(--panel-2);
}

.sb-thumb {
  width: 100%;
  height: 120px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--border);
  display: block;
  cursor: zoom-in;
  transition: border-color 0.15s ease;
}

.sb-thumb:hover {
  border-color: var(--accent);
}

/* 分镜视频播放器：poster 是截图，点了才加载片段 */
.sb-video {
  width: 100%;
  height: 170px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: #000;
  display: block;
  object-fit: contain;
}

.sb-video:hover {
  border-color: var(--accent);
}

.sb-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.sb-actions .mini {
  flex: 1;
  padding: 4px 0;
  font-size: 11px;
  margin-top: 0;
}

.sb-meta {
  font-size: 10px;
  color: var(--muted);
  margin: 6px 0 4px;
}

.sb-text {
  font-size: 11.5px;
  color: #c3c9d6;
  line-height: 1.55;
  margin: 0;
}

.sb-muted {
  font-size: 11px;
  color: #7f8798;
  line-height: 1.5;
  margin: 3px 0 0;
}

.sb-check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
}

.sb-check span {
  white-space: nowrap;
}

.sb-cell .mini {
  margin-top: 8px;
  width: auto;
  padding: 4px 12px;
}
</style>
