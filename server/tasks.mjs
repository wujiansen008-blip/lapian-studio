import { callChat, parseModelJson } from "./ai.mjs";
import {
  ANALYZE_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
  FINAL_COMPARE_SYSTEM_PROMPT,
  FISSION_SYSTEM_PROMPT,
  FISSION_SLOT_ROLES,
  FISSION_SLOT_ROLE_LABELS,
  FISSION_STRATEGIES,
  FISSION_STRATEGY_LABELS,
  FINAL_COMPARE_DIMENSIONS,
} from "./prompts.mjs";

const MAX_CLOUD_FRAMES = 18;
// 三段式抽帧后每张表只放 3 镜，9 镜需要 3 张表，不能少发
const MAX_SHEET_IMAGES = 3;

function sheetImages(sheets = []) {
  return sheets
    .map((s) => s?.image)
    .filter((img) => typeof img === "string" && img.startsWith("data:image"))
    .slice(0, MAX_SHEET_IMAGES);
}

function frameImages(frames = [], limit = MAX_CLOUD_FRAMES) {
  return frames
    .map((f) => f?.image)
    .filter((img) => typeof img === "string" && img.startsWith("data:image"))
    .slice(0, limit);
}

/** 任务一：爆款拉片分析（0.1.18 完整方法论，含复刻方案与剪映脚本） */
export async function runAnalyze({ config, payload }) {
  const frames = payload.frames || [];
  const sheets = payload.contactSheets || [];
  const useSheets = sheets.some((s) => s?.image);

  const userText = JSON.stringify(
    {
      transcript: payload.transcript || "",
      productInput: payload.productInput || "",
      audienceInput: payload.audienceInput || "",
      dialectMode: payload.dialectMode || "auto",
      filename: payload.filename || "",
      duration: payload.duration || 0,
      localAnalysis: payload.localAnalysis || {},
      frameTimes: frames.map((frame) => ({
        index: frame.index,
        start: frame.start,
        end: frame.end,
        browserSubtitle: frame.subtitle || "",
        speech: frame.speech || "",
      })),
      contactSheetMeta: sheets.map((sheet, index) => ({
        index,
        frameIndexes: sheet.frameIndexes || [],
        layout: sheet.layout || "",
        phases: sheet.phases || [],
      })),
    },
    null,
    2,
  );

  const images = useSheets ? sheetImages(sheets) : frameImages(frames);
  console.log(
    "[analyze] mode=" + (useSheets ? "sheet" : "frame") +
      " sheets=" + sheets.length +
      " images=" + images.length +
      " sizes=" + images.map((img) => Math.round(img.length / 1024) + "KB").join(",") +
      " head=" + (images[0] || "").slice(0, 40),
  );
  const { text, usage } = await callChat({
    config,
    system: ANALYZE_SYSTEM_PROMPT,
    userText: `素材信息：\n${userText}`,
    images,
    maxTokens: 16000,
    timeoutMs: 300000,
  });

  const analysis = parseModelJson(text);
  const expected = frames.length;
  if (Array.isArray(analysis.frameNotes) && expected && analysis.frameNotes.length < expected) {
    analysis.frameNotesWarning = `模型只返回了 ${analysis.frameNotes.length}/${expected} 个分镜，建议减少分镜数重跑`;
  }
  return { analysis, usage, visualMode: useSheets ? "contact_sheet" : "per_frame" };
}

/** 任务二：投放复盘（0.1.18，含曲线峰值识别） */
export async function runReview({ config, payload }) {
  const screenshots = (payload.screenshots || []).filter((item) => item?.image);
  if (!screenshots.length) throw new Error("投放复盘需要至少一张千川后台截图");

  const userText = JSON.stringify(
    {
      filename: payload.filename || "",
      duration: payload.duration || 0,
      localAnalysis: payload.localAnalysis || {},
      productContext: payload.productContext || {},
      storyboardFrames: payload.storyboardFrames || [],
      screenshotMeta: screenshots.map((item) => ({
        key: item.key,
        title: item.title,
        fileName: item.fileName || "",
      })),
    },
    null,
    2,
  );

  const { text, usage } = await callChat({
    config,
    system: REVIEW_SYSTEM_PROMPT,
    userText: `复盘资料：\n${userText}`,
    images: screenshots.map((item) => item.image).slice(0, 4),
    maxTokens: 3200,
    timeoutMs: 300000,
  });

  return { review: parseModelJson(text), usage };
}

/** 任务三：终局对比（0.1.18，含时间轴对齐与 2x3 逐镜对照） */
export async function runFinalCompare({ config, payload }) {
  const sheets = payload.contactSheets || [];
  const benchmarkFrames = payload.benchmarkFrames || [];
  const finalFrames = payload.finalFrames || [];

  const userText = JSON.stringify(
    {
      benchmark: payload.benchmark || {},
      final: payload.final || {},
      shotPairs: payload.shotPairs || [],
      timelineAlignment: payload.timelineAlignment || {},
      dimensions: FINAL_COMPARE_DIMENSIONS,
      notes: payload.notes || "",
      contactSheetMeta: sheets.map((sheet, index) => ({
        index,
        pairCount: sheet.pairCount || 0,
        layout: sheet.layout || "",
        shotIndex: sheet.shotIndex,
        phases: sheet.phases || [],
        benchmarkTimes: sheet.benchmarkTimes || [],
        finalTimes: sheet.finalTimes || [],
        alignmentMode: sheet.alignmentMode || "",
        timeToleranceSeconds: sheet.timeToleranceSeconds,
      })),
    },
    null,
    2,
  );

  const visionImages = sheets.some((s) => s?.image)
    ? sheetImages(sheets)
    : [...frameImages(benchmarkFrames, 4), ...frameImages(finalFrames, 4)];

  const run = async (images, timeoutMs) => {
    const { text, usage } = await callChat({
      config,
      system: FINAL_COMPARE_SYSTEM_PROMPT,
      userText: `对比资料：\n${userText}`,
      images,
      maxTokens: 3200,
      timeoutMs,
    });
    return { result: parseModelJson(text), usage };
  };

  if (!visionImages.length) {
    const { result, usage } = await run([], 300000);
    return { result: { ...result, apiCompareMode: "text" }, usage };
  }

  try {
    const { result, usage } = await run(visionImages, 90000);
    return { result: { ...result, apiCompareMode: "vision" }, usage };
  } catch (error) {
    const { result, usage } = await run([], 300000);
    return {
      result: {
        ...result,
        apiCompareMode: "text_fallback",
        apiCompareWarning: `视觉对比未在 90 秒内完成，已改用分镜时间线与口播文本对比。原始原因：${error.message || error}`,
      },
      usage,
    };
  }
}

function normalizeFissionShots(raw, frames) {
  const list = Array.isArray(raw?.shots) ? raw.shots : [];
  if (!list.length) throw new Error("模型返回的裂变矩阵里没有分镜");

  return frames.map((frame, index) => {
    const shotId = String(frame.shotId || `shot_${index + 1}`);
    const source =
      list.find((item) => String(item?.shotId || "") === shotId) ||
      list.find((item) => Number(item?.shotIndex) === index + 1) ||
      list[index] ||
      {};

    const fallbackRole = index === 0 ? "hook" : index === frames.length - 1 ? "cta" : "transition";
    const slotRole = FISSION_SLOT_ROLES.includes(source.slotRole) ? source.slotRole : fallbackRole;
    const strategy = FISSION_STRATEGIES.includes(source.strategy) ? source.strategy : "retain_original";

    return {
      shotId,
      shotIndex: index + 1,
      start: frame.start,
      end: frame.end,
      slotRole,
      slotRoleLabel: String(source.slotRoleLabel || FISSION_SLOT_ROLE_LABELS[slotRole] || ""),
      strategy,
      strategyLabel: String(source.strategyLabel || FISSION_STRATEGY_LABELS[strategy] || ""),
      priority: ["high", "medium", "low"].includes(source.priority) ? source.priority : "medium",
      stableSkeleton: Array.isArray(source.stableSkeleton) ? source.stableSkeleton : [],
      voiceoverPool: Array.isArray(source.voiceoverPool) ? source.voiceoverPool : [],
      visualPool: Array.isArray(source.visualPool) ? source.visualPool : [],
      textPool: Array.isArray(source.textPool) ? source.textPool : [],
      combinationRule: source.combinationRule && typeof source.combinationRule === "object" ? source.combinationRule : {},
      materialRecommendation: source.materialRecommendation || {},
      validationMetric: String(source.validationMetric || ""),
      evidenceWarning: String(source.evidenceWarning || ""),
      reason: String(source.reason || ""),
    };
  });
}

/** 任务四：逐镜裂变（0.1.18 新增，槽位矩阵） */
export async function runFission({ config, payload }) {
  const frames = payload.frames || [];
  if (!frames.length) throw new Error("逐镜裂变需要先有分镜数据，请先完成拉片");

  const system = FISSION_SYSTEM_PROMPT.replace("${frames.length}", String(frames.length));
  const userText = JSON.stringify(
    {
      productProfile: payload.productProfile || {},
      fissionGoal: payload.fissionGoal || "综合提升",
      fullTranscript: payload.fullTranscript || "",
      analysisSummary: payload.analysisSummary || {},
      frames: frames.map((frame) => ({
        shotId: frame.shotId || `shot_${Number(frame.index) + 1}`,
        shotIndex: Number(frame.index) + 1,
        start: frame.start,
        end: frame.end,
        duration: Number((Number(frame.end) - Number(frame.start)).toFixed(2)),
        speech: frame.speech || "",
        subtitle: frame.subtitle || "",
        visualDescription: frame.visualDescription || "",
      })),
    },
    null,
    2,
  );

  const { text, usage } = await callChat({
    config,
    system,
    userText: `产品与分镜资料：\n${userText}`,
    images: [],
    maxTokens: 16000,
    timeoutMs: 420000,
  });

  const parsed = parseModelJson(text);
  const normalized = {
    methodologyVersion: String(parsed?.methodologyVersion || "superdir_slot_matrix_v1"),
    globalStrategy: parsed?.globalStrategy || {},
    shots: normalizeFissionShots(parsed, frames),
  };
  return { fission: normalized, usage };
}
