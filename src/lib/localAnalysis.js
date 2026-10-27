/**
 * 本地规则引擎：不花一分钱，先给一份结构化初判。
 * 云端 AI 的任务是"精修 + 逐格画面核对"，不是从零开始。
 * 规则表集中在 RULES 里，按品类调这里即可。
 */

const RULES = {
  price: ["元", "块", "9.9", "优惠", "到手价", "券", "限时", "拍一发", "买一送", "赠", "包邮", "划算", "秒杀", "福利", "价格", "折"],
  proof: ["成分", "配方", "含量", "菌株", "专利", "实验", "检测", "报告", "技术", "工艺", "进口", "纯度", "添加", "认证", "标准"],
  scene: ["上班", "熬夜", "早餐", "空腹", "减脂", "控制", "体重", "孩子", "老人", "家里", "办公室", "每天", "坚持", "怕", "担心", "困扰", "难受", "尴尬", "夏天", "冬天"],
  audience: ["姐妹", "宝妈", "上班族", "兄弟", "老板", "女生", "男生", "学生", "中年人", "打工人", "新手", "敏感"],
  visualSense: ["看", "颜色", "颜值", "拉丝", "质地", "包装", "镜头", "特写"],
  audioSense: ["听", "声音", "脆", "咔", "沙沙"],
  touchSense: ["摸", "手感", "软", "硬", "质感", "凉", "滑"],
  tasteSense: ["口感", "香", "好喝", "喝", "吃", "酥", "脆", "味道", "甜", "香浓", "嚼"],
  emotionSense: ["心疼", "理解", "共鸣", "陪", "懂你", "不容易"],
};

const OPENING_HOOKS = [
  { hook: "点名受众", words: ["姐妹", "宝妈", "上班族", "兄弟", "老板", "女生", "男生", "学生", "打工人"] },
  { hook: "警告避坑", words: ["别", "千万", "小心", "注意", "避坑", "不要再", "别再"] },
  { hook: "福利优惠", words: ["福利", "优惠", "券", "免费", "送", "打折", "便宜"] },
  { hook: "名人背书", words: ["代言", "明星", "名人", "同款", "专家", "医生"] },
  { hook: "用户口碑", words: ["好评", "回购", "复购", "粉丝", "用过都说"] },
  { hook: "揭露痛点", words: ["困扰", "难受", "尴尬", "烦", "痛苦", "受够"] },
  { hook: "彰显效果", words: ["效果", "变", "瘦了", "改善", "好了", "看得见"] },
  { hook: "提出疑问", words: ["是不是", "有没有", "为什么", "知道吗", "你还在"] },
  { hook: "内幕揭秘", words: ["内幕", "真相", "揭秘", "其实", "行业"] },
  { hook: "数据支撑", words: ["%", "倍", "数据", "统计", "研究", "万人"] },
  { hook: "反差对比", words: ["之前", "现在", "对比", "反而", "while"] },
  { hook: "反常识", words: ["居然", "竟然", "并不是", "恰恰相反"] },
  { hook: "情绪共鸣", words: ["心疼", "理解", "我也是", "谁懂"] },
  { hook: "猎奇好奇", words: ["绝对", "想不到", "居然", "好奇"] },
  { hook: "直陈结论", words: ["就是", "结论", "直接说", "一句话"] },
  { hook: "炫耀成就", words: ["卖了", "销量", "爆了", "第一", "回头客"] },
  { hook: "夸张句式", words: ["史上", "最", "唯一", "绝对", "顶级"] },
  { hook: "正话反说", words: ["不是", "反而", "越"] },
  { hook: "时事热点", words: ["最近", "今年", "现在", "热点", "上热搜"] },
  { hook: "指令动作", words: ["记住", "别划走", "看这里", "停", "往下看"] },
  { hook: "名言金句", words: ["俗话说", "有人说", "记住一句话", "老话"] },
];

function countHits(text, words) {
  let hits = 0;
  for (const w of words) {
    if (!w) continue;
    const matches = text.split(w).length - 1;
    hits += matches;
  }
  return hits;
}

function splitTranscript(raw) {
  return String(raw || "")
    .split(/[\n。！？!?；;]+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function buildLocalAnalysis({ transcript, productInput, audienceInput, fileName = "", frameCount = 0 }) {
  const text = `${transcript || ""} ${productInput || ""} ${audienceInput || ""} ${fileName}`;
  const lines = splitTranscript(transcript);
  const first = lines[0] || "";

  const priceScore = countHits(text, RULES.price);
  const proofScore = countHits(text, RULES.proof);
  const sceneScore = countHits(text, RULES.scene);

  let layer = "3.1";
  let layerReason = "以场景与人群痛点为主，属于用户视角素材";
  if (priceScore >= 2 && priceScore >= proofScore) {
    layer = "3.99";
    layerReason = `价格与权益词命中 ${priceScore} 次，属于价格权益/强转化型`;
  } else if (proofScore >= 2 && proofScore > sceneScore) {
    layer = "3.2";
    layerReason = `成分、功能、证明类词命中 ${proofScore} 次，属于产品证明型`;
  } else if (!lines.length && !frameCount) {
    layer = "待定";
    layerReason = "还没有口播文本与分镜";
  }

  const perspective = layer === "3.99" ? "价格视角" : layer === "3.2" ? "产品视角" : "用户视角";

  const openingHits = OPENING_HOOKS.map((rule) => ({
    hook: rule.hook,
    score: countHits(first, rule.words) * 3 + countHits(text.slice(0, 80), rule.words),
  })).sort((a, b) => b.score - a.score);

  const opening = openingHits[0]?.score > 0 ? openingHits[0].hook : "未识别";

  const senseScores = [
    { mode: "嗅觉与味觉", score: countHits(text, RULES.tasteSense) },
    { mode: "视觉种草", score: countHits(text, RULES.visualSense) },
    { mode: "听觉种草", score: countHits(text, RULES.audioSense) },
    { mode: "触觉联想", score: countHits(text, RULES.touchSense) },
    { mode: "情感种草", score: countHits(text, RULES.emotionSense) },
  ].sort((a, b) => b.score - a.score);

  const middleMode = senseScores[0].score > 0 ? senseScores[0].mode : "认知种草";

  const audienceHit = RULES.audience.filter((w) => text.includes(w));
  const audience = audienceInput?.trim() || (audienceHit.length ? audienceHit[0] : "未识别");

  const ending = layer === "3.99" ? "饥饿营销" : layer === "3.2" ? "背书引导" : "痛点引导";

  const structure = lines.length
    ? `开头（约前 15%）抛出 ${opening}；中段以${middleMode}承接卖点；结尾走${ending}收口`
    : "等待口播转写后生成";

  return {
    product: productInput?.trim() || "未填写",
    layer,
    layerReason,
    confidence: lines.length ? Math.min(0.55 + lines.length * 0.02, 0.85) : 0.2,
    perspective,
    audience,
    opening,
    hook: first.slice(0, 60) || "未识别",
    selling: proofScore > 0 ? "成分/功能" : "体验/场景",
    middleMode,
    sellingMethods: senseScores.filter((s) => s.score > 0).map((s) => s.mode),
    ending,
    structure,
    lineCount: lines.length,
    scores: { priceScore, proofScore, sceneScore },
  };
}
