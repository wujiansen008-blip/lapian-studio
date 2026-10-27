import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_RECORDS = 200;

function historyRoot(dataDir) {
  return join(dataDir, "history");
}

function recordDir(dataDir, id) {
  return join(historyRoot(dataDir), id);
}

function recordFile(dataDir, id) {
  return join(recordDir(dataDir, id), "record.json");
}

function safeId(id) {
  const value = String(id || "");
  if (!/^[a-z0-9-]{8,64}$/i.test(value)) throw new Error("历史记录 ID 无效");
  return value;
}

function decodeDataUrl(dataUrl) {
  const text = String(dataUrl || "");
  const comma = text.indexOf(",");
  if (comma < 0) return null;
  try {
    return Buffer.from(text.slice(comma + 1), "base64");
  } catch {
    return null;
  }
}

/** 保存一条拉片记录：元数据进 record.json，分镜图片落盘为独立 jpg。 */
export async function saveRecord(dataDir, payload = {}) {
  const analysis = payload.analysis || null;
  if (!analysis) throw new Error("没有可保存的分析结果");

  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const dir = recordDir(dataDir, id);
  await mkdir(dir, { recursive: true });

  const framesMeta = [];
  const inputFrames = Array.isArray(payload.frames) ? payload.frames : [];

  for (const frame of inputFrames) {
    const index = Number(frame.index) || 0;
    const phases = [];

    const write = async (name, dataUrl) => {
      const buffer = decodeDataUrl(dataUrl);
      if (!buffer) return "";
      await writeFile(join(dir, name), buffer);
      return name;
    };

    if (Array.isArray(frame.phases) && frame.phases.length) {
      for (const [i, phase] of frame.phases.entries()) {
        const name = await write(`f${index}-p${i}.jpg`, phase.image);
        if (name) phases.push({ label: String(phase.label || ""), time: Number(phase.time) || 0, file: name });
      }
    }

    const mainFile = await write(`f${index}-mid.jpg`, frame.image);

    framesMeta.push({
      index,
      start: Number(frame.start) || 0,
      end: Number(frame.end) || 0,
      time: Number(frame.time) || 0,
      mainFile,
      phases,
    });
  }

  const record = {
    id,
    createdAt: new Date().toISOString(),
    fileName: String(payload.fileName || ""),
    duration: Number(payload.duration) || 0,
    sourceId: String(payload.sourceId || ""),
    productInput: String(payload.productInput || ""),
    audienceInput: String(payload.audienceInput || ""),
    category: String(payload.category || "未分类"),
    notes: normalizeNotes(payload.notes),
    layer: String(analysis.layer || ""),
    opening: String(analysis.opening || ""),
    product: String(analysis.whatIsSold || analysis.product || ""),
    transcript: String(payload.transcript || ""),
    localAnalysis: payload.localAnalysis || {},
    analysis,
    frames: framesMeta,
  };

  await writeFile(recordFile(dataDir, id), JSON.stringify(record, null, 2), "utf8");
  await pruneOld(dataDir);
  return summarize(record, id);
}

/** 笔记结构：general 为整片判断，frames 按分镜下标存逐镜笔记 */
function normalizeNotes(input) {
  const raw = input && typeof input === "object" ? input : {};
  const frames = {};
  const src = raw.frames && typeof raw.frames === "object" ? raw.frames : {};
  for (const [k, v] of Object.entries(src)) {
    const text = String(v || "").slice(0, 4000);
    if (text.trim()) frames[String(k)] = text;
  }
  return { general: String(raw.general || "").slice(0, 8000), frames };
}

function notesFilled(notes) {
  if (!notes) return false;
  if (String(notes.general || "").trim()) return true;
  return Object.values(notes.frames || {}).some((v) => String(v || "").trim());
}

function summarize(record, id) {
  return {
    id,
    createdAt: record.createdAt,
    fileName: record.fileName,
    duration: record.duration,
    category: record.category || "未分类",
    hasNotes: notesFilled(record.notes),
    layer: record.layer,
    opening: record.opening,
    product: record.product,
    frameCount: Array.isArray(record.frames) ? record.frames.length : 0,
    thumb: record.frames?.length ? `/api/history/${id}/img/${record.frames[0].mainFile}` : "",
  };
}

async function pruneOld(dataDir) {
  const ids = await listIds(dataDir);
  if (ids.length <= MAX_RECORDS) return;
  const stale = ids.slice(MAX_RECORDS);
  for (const id of stale) {
    await rm(recordDir(dataDir, id), { recursive: true, force: true }).catch(() => {});
  }
}

async function listIds(dataDir) {
  const root = historyRoot(dataDir);
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  // 目录名以时间戳前缀开头，倒序即最新在前
  return ids.sort().reverse();
}

export async function listRecords(dataDir) {
  const ids = await listIds(dataDir);
  const out = [];
  for (const id of ids) {
    try {
      const raw = await readFile(recordFile(dataDir, id), "utf8");
      out.push(summarize(JSON.parse(raw), id));
    } catch {
      /* 跳过损坏记录 */
    }
  }
  return out;
}

/** 只更新笔记，不动其他字段 */
export async function updateRecordNotes(dataDir, id, notes) {
  const safe = safeId(id);
  const file = recordFile(dataDir, safe);
  const record = JSON.parse(await readFile(file, "utf8"));
  record.notes = normalizeNotes(notes);
  await writeFile(file, JSON.stringify(record, null, 2), "utf8");
  return { ok: true, hasNotes: notesFilled(record.notes) };
}

/** 只更新分类，不动其他字段 */
export async function updateRecordCategory(dataDir, id, category) {
  const safe = safeId(id);
  const file = recordFile(dataDir, safe);
  const record = JSON.parse(await readFile(file, "utf8"));
  record.category = String(category || "未分类").slice(0, 20);
  await writeFile(file, JSON.stringify(record, null, 2), "utf8");
  return summarize(record, safe);
}

export async function getRecord(dataDir, id) {
  const safe = safeId(id);
  const raw = await readFile(recordFile(dataDir, safe), "utf8");
  const record = JSON.parse(raw);

  // 把文件名转成可访问的 URL，前端直接拿去渲染
  const frames = (record.frames || []).map((frame) => ({
    index: frame.index,
    start: frame.start,
    end: frame.end,
    time: frame.time,
    image: frame.mainFile ? `/api/history/${safe}/img/${frame.mainFile}` : "",
    phases: (frame.phases || []).map((phase) => ({
      label: phase.label,
      time: phase.time,
      image: `/api/history/${safe}/img/${phase.file}`,
    })),
  }));

  return { ...record, frames };
}

export async function imagePath(dataDir, id, fileName) {
  const safe = safeId(id);
  const name = String(fileName || "");
  if (!/^f\d+-[a-z0-9]+\.jpg$/i.test(name)) throw new Error("图片名无效");
  const path = join(recordDir(dataDir, safe), name);
  if (!existsSync(path)) throw new Error("图片不存在");
  return path;
}

export async function deleteRecord(dataDir, id) {
  const safe = safeId(id);
  await rm(recordDir(dataDir, safe), { recursive: true, force: true });
  return { id: safe };
}
