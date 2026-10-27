/**
 * OpenAI 兼容的对话/视觉调用层。
 * 支持任意兼容 /v1/chat/completions 的服务（OpenAI、DeepSeek、豆包、通义、智谱、硅基流动、各类中转）。
 */

const DEFAULT_TIMEOUT_MS = 180000;

function joinUrl(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export async function callChat({
  config,
  system,
  userText,
  images = [],
  maxTokens = 4000,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  temperature,
}) {
  const { baseUrl, apiKey, model } = config || {};
  if (!baseUrl) throw new Error("未配置 API 地址（Base URL）");
  if (!apiKey) throw new Error("未配置 API Key");
  if (!model) throw new Error("未配置模型名称");

  const userContent = [{ type: "text", text: userText }];
  for (const image of images) {
    if (!image) continue;
    userContent.push({ type: "image_url", image_url: { url: image, detail: "high" } });
  }

  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
    max_tokens: maxTokens,
  };
  if (typeof temperature === "number") body.temperature = temperature;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(joinUrl(baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === "AbortError") {
      throw new Error(`模型请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw new Error(`模型请求失败：${error.message || error}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 600);
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.error?.message || parsed?.message || detail;
    } catch {
      /* 保留原始片段 */
    }
    throw new Error(`模型接口返回 ${response.status}：${detail}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`模型返回不是合法 JSON：${text.slice(0, 200)}`);
  }

  const content =
    payload?.choices?.[0]?.message?.content ??
    payload?.output_text ??
    payload?.choices?.[0]?.text ??
    "";

  const flattened = Array.isArray(content)
    ? content.map((part) => part?.text || "").join("")
    : String(content || "");

  if (!flattened.trim()) {
    throw new Error("模型返回内容为空");
  }
  return { text: flattened, usage: payload?.usage || null, raw: payload };
}

/**
 * 修复字符串值内部的裸引号。
 * 模型常把 {"product":"含"擦手巾"的盒子"} 写成这样，导致 JSON 非法。
 * 判定：字符串内的引号，若后面紧跟 , : } ] 或结束，则是收尾引号；否则是内部引号，需转义。
 */
function repairRawQuotes(input) {
  let out = "";
  let inString = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "\\") {
      out += ch + (input[i + 1] || "");
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (!inString) {
        inString = true;
        out += ch;
        continue;
      }
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j += 1;
      const next = input[j];
      if (next === ":" || next === "," || next === "}" || next === "]" || j >= input.length) {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 从模型输出里稳健地抠出 JSON。
 * 依次尝试：整体解析 → 去 Markdown 围栏 → 首个 { 到末个 } → 修复裸引号 → 首个 [ 到末个 ]。
 */
export function parseModelJson(text) {
  const source = String(text || "").trim();
  const attempts = [];

  attempts.push(source);

  const fence = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) attempts.push(fence[1].trim());

  const firstBrace = source.indexOf("{");
  const lastBrace = source.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const braced = source.slice(firstBrace, lastBrace + 1);
    attempts.push(braced);
    // 裸引号修复（模型把中文引号写成英文引号时最常见）
    attempts.push(repairRawQuotes(braced));
    attempts.push(repairRawQuotes(source));
  }

  const firstBracket = source.indexOf("[");
  const lastBracket = source.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    const bracketed = source.slice(firstBracket, lastBracket + 1);
    attempts.push(bracketed);
    attempts.push(repairRawQuotes(bracketed));
  }

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      /* 下一个 */
    }
  }

  // 头尾都给出来，方便判断是「引号问题」还是「输出被截断」
  const tail = source.length > 200 ? `…${source.slice(-200)}` : "";
  const looksTruncated = !/}\s*$/.test(source);
  throw new Error(
    `模型输出无法解析为 JSON${looksTruncated ? "（疑似被截断，结尾没有闭合括号）" : ""}：` +
      `${source.slice(0, 200)}${tail}`,
  );
}

export async function testConnection(config) {
  const { text } = await callChat({
    config,
    system: "你是一个连通性测试助手，只回复两个字：可用",
    userText: "连通性测试",
    maxTokens: 16,
    timeoutMs: 30000,
  });
  return { ok: true, reply: text.trim().slice(0, 50) };
}
