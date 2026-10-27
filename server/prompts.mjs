/**
 * 提示词与文本工具。
 * 四套方法论提示词原文在 prompts-core.mjs（自动提取自 0.1.18），这里只做再导出与工具函数。
 */

export * from "./prompts-core.mjs";

/**
 * 同音/近音纠错表：whisper 对行业专名极易出错，这里做转写后兜底替换。
 * 规则按品类维护 —— 原版把它写死成单一品类，这里做成可在设置里编辑。
 */
export const DEFAULT_CORRECTIONS = [
  ["可生酱", "可升降"],
  ["生酱沥水", "升降沥水"],
  ["生酱", "升降"],
  ["溺水", "沥水"],
  ["鸭套", "牙套"],
  ["压套", "牙套"],
  ["长眉甲", "长美甲"],
  ["至今包", "纸巾包"],
  ["总共丢", "总弄丢"],
  ["空服", "空腹"],
  ["一生菌", "益生菌"],
  ["逼生菌", "益生菌"],
  ["必生菌", "益生菌"],
];

/**
 * 转写提示词：把产品名、人群、行业词表喂给 whisper。
 * 实测要点：
 *   1) 首句必须明确"用简体中文转写"，否则 whisper-small 会稳定输出繁体；
 *   2) 术语表能显著纠正同音错字（如"沥水"被写成"粒水"）。
 */
export function buildTranscribePrompt({ productHint = "", audienceHint = "", glossary = [] } = {}) {
  const clean = (v, max = 160) => String(v || "").replace(/\s+/g, " ").trim().slice(0, max);
  const terms = Array.isArray(glossary) ? glossary.map((t) => clean(t, 20)).filter(Boolean) : [];
  const parts = [
    "以下是普通话的短视频口播，请用简体中文转写，不要翻译，不要加标点以外的修饰。",
    clean(productHint) ? `品牌/产品名：${clean(productHint)}。` : "",
    clean(audienceHint, 100) ? `目标人群/场景：${clean(audienceHint, 100)}。` : "",
    terms.length ? `术语须按此写法：${terms.join("、")}。` : "",
  ].filter(Boolean);
  return parts.join(" ").slice(0, 420);
}

/** 应用纠错表。传入 null/空数组时用默认表。 */
export function applyCorrections(text, corrections = DEFAULT_CORRECTIONS) {
  let out = String(text || "");
  const table = Array.isArray(corrections) && corrections.length ? corrections : DEFAULT_CORRECTIONS;
  for (const entry of table) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [from, to] = entry;
    if (!from) continue;
    out = out.split(String(from)).join(String(to));
  }
  return out;
}
