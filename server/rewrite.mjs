/**
 * 爆款脚本复刻改写
 * 移植自 viral-short-video-script-rewriter skill：
 * 保留原稿的结构、句式节奏、情绪走向、冲突与成交钩子，只替换内容主体。
 */
import { callChat } from "./ai.mjs";

const SYSTEM = [
  "你是短视频脚本复刻改写专家。你的任务是把用户提供的爆款原稿，改写成适配目标产品的新脚本。",
  "改写必须保留原稿的结构、句式节奏、情绪走向、冲突设计、信任建立方式、成交钩子和大致篇幅，",
  "只替换内容主体（产品、卖点、案例、场景、行动引导）。",
  "最终只输出改写后的脚本正文，不要任何分析、解释、标题、字数统计或过程说明。",
].join("");

function targetBlock(t = {}) {
  const rows = [
    ["目标名称", t.name],
    ["人设/品牌", t.persona],
    ["品类/场景", t.category],
    ["核心卖点", t.sellingPoints],
    ["规格/交付内容", t.specs],
    ["价格/优惠", t.price],
    ["信任背书", t.proof],
    ["目标用户", t.audience],
    ["竞品/替代方案痛点", t.painPoints],
    ["使用/转化场景", t.scenario],
    ["禁用词或合规要求", t.compliance],
    ["行动引导", t.cta],
  ]
    .filter(([, v]) => String(v || "").trim())
    .map(([k, v]) => `${k}：${String(v).trim()}`);

  if (t.extra && String(t.extra).trim()) {
    rows.push(`补充说明：${String(t.extra).trim()}`);
  }
  return rows.length ? rows.join("\n") : "（用户未提供目标信息，请仅按品类安全表达改写，并在开头追问关键信息）";
}

export function buildRewriteMessages({ benchmark = "", target = {} } = {}) {
  const userText = [
    "【原稿】（要复刻结构的爆款脚本）",
    String(benchmark || "").trim(),
    "",
    "【目标画像】（要换成的内容）",
    targetBlock(target),
    "",
    "请按下面的内部流程改写，但只输出最终脚本：",
    "1. 统计原稿字数，判定档位：短稿<200字 / 中稿200-500字 / 长稿>500字。",
    "2. 把原稿切成句子或口播节拍，保留原有顺序和句数。",
    "3. 逐句标注功能：开头钩子与痛点、冲突或质疑、方案与机制、证明与对比、情绪共鸣、报价与行动引导。",
    "4. 只替换必要的硬标识：品牌名、产品名、人名、地名、竞品标签、品类专属细节、平台词、旧优惠。",
    "5. 保留有价值的结构：逻辑链、案例细节、步骤、情绪措辞、对比形态、数据式表达、信任建立、成交压力。",
    "6. 逐句改写：原稿超过 200 字时不得合并独立句子；每句承担的角色与原句等价；用目标事实替换内容。",
    "7. 自检（不要输出自检过程）：",
    "   - 短稿改写后长度不低于原稿 90%；中稿 95%-110%；长稿 90%-105%。",
    "   - 句数相差不超过 1-2 句（原稿高度碎片化除外）。",
    "   - 每个主张都有目标画像支撑，或使用品类安全表达。",
    "   - 开头足够尖锐、直接、痛点驱动。",
    "   - 结尾有明确行动（点击左下角/进直播间/下单/预约/关注/私信/抢优惠）。",
    "",
    "【改写规则】",
    "- 情绪基线与原稿一致：对抗保持对抗，真诚保持真诚，怀旧保持怀旧，紧迫保持紧迫，权威保持权威，搞笑保持笑点节奏。",
    "- 能保留句式就保留，只在目标替换需要时改措辞。",
    "- 说服强度不低于原稿；原本有效的句子要改造而不是删掉。",
    "- 不过度压缩：保留信息密度，尤其是案例、过程细节、证明链、场景细节、社会证明、情绪铺垫。",
    "- 不过度扩写：只在维持长度、澄清相关性或补强证明时增加细节。",
    "- 禁止编造：资质认证、检测数据、成分比例、医疗效果、理财收益、奖项、官方背书、保证承诺、折扣力度，除非用户已提供。",
    "- 原稿的行业化机制要换成目标行业的类比：成分/配方→方法论/材料/工艺/服务体系；厚敷薄涂→日常用/加强用；拍一发多→套餐/赠品/会员权益；他人质疑→行业分歧/常见误区/用户犹豫；亲友验证→用户反馈/复购/学员案例。",
    "- 去掉会暴露原片的硬标签，但保留周边逻辑和情绪张力。",
    "",
    "【输出要求】",
    "- 只输出改写后的脚本正文。",
    "- 不要以“改写后的脚本”“以下是”“脚本如下”开头。",
    "- 不要 markdown 标题、项目符号、分析说明、字数统计。",
    "- 原稿有分段就保留分段，帮助还原节奏。",
  ].join("\n");

  return { system: SYSTEM, userText };
}

export async function runRewrite({ config, payload = {} }) {
  const benchmark = String(payload.benchmark || "").trim();
  if (!benchmark) throw new Error("缺少原稿文本");
  if (benchmark.length < 30) throw new Error("原稿太短，至少要有 30 个字");

  const { system, userText } = buildRewriteMessages({
    benchmark,
    target: payload.target || {},
  });

  // 原稿越长，输出上限越高（按原稿 1.3 倍估算，中文 1 字约 1 token）
  const maxTokens = Math.min(16000, Math.max(4000, Math.round(benchmark.length * 1.6)));

  const result = await callChat({
    config,
    system,
    userText,
    maxTokens,
    temperature: 0.55,
    timeoutMs: 180000,
  });

  const script = String(result?.text || "").trim();
  if (!script) throw new Error("模型没有返回内容");

  return {
    script,
    benchmarkLength: benchmark.length,
    scriptLength: script.length,
    ratio: benchmark.length ? Number((script.length / benchmark.length).toFixed(2)) : 0,
    usage: result?.usage || null,
  };
}
