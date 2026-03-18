function sendJson(res, code, data) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.end(JSON.stringify(data));
}

function fallbackResponse() {
  const positivePrompt =
    "保留主体轮廓与关键构图，强化材质描述、光影层次和风格一致性，主体清晰，背景简洁，细节丰富，high detail, cinematic lighting";
  const negativePrompt = "text, watermark, low quality, blurry, bad anatomy, noisy background";
  return {
    sceneType: "纯文本生成",
    confidence: 68,
    analysisResult: {
      problems: [
        "当前输入缺少明确镜头和构图约束，模型容易随机发挥。",
        "风格词和材质词可能不够具体，导致质感不稳定。",
      ],
      strengths: ["任务目标清晰，主体方向明确。", "可通过补充负向词快速提升稳定性。"],
    },
    solutions: [
      "按 主体 + 场景 + 镜头 + 光影 + 风格 + 质量参数 重写提示词。",
      "加入负向词：text, watermark, low quality, blurry, bad anatomy。",
    ],
    positivePrompt,
    negativePrompt,
    optimizedPrompt: `正向提示词：${positivePrompt}\n\n负向提示词：${negativePrompt}`,
    recommendedParams: {
      model: "Seedream 4.0",
      ratio: "1024x1536 / 2:3",
      negativePrompt,
    },
  };
}

function normalizeResult(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const fallback = fallbackResponse();
  const positivePrompt = data.positivePrompt || data.optimizedPrompt || fallback.positivePrompt;
  const negativePrompt =
    data.negativePrompt || data.recommendedParams?.negativePrompt || fallback.negativePrompt;
  return {
    sceneType: data.sceneType || "纯文本生成",
    confidence: Math.max(1, Math.min(100, Number(data.confidence || 75))),
    analysisResult: {
      problems: Array.isArray(data.analysisResult?.problems)
        ? data.analysisResult.problems.slice(0, 4)
        : fallback.analysisResult.problems,
      strengths: Array.isArray(data.analysisResult?.strengths)
        ? data.analysisResult.strengths.slice(0, 4)
        : fallback.analysisResult.strengths,
    },
    solutions: Array.isArray(data.solutions)
      ? data.solutions.slice(0, 4)
      : fallback.solutions,
    positivePrompt,
    negativePrompt,
    optimizedPrompt:
      data.optimizedPrompt ||
      `正向提示词：${positivePrompt}\n\n负向提示词：${negativePrompt}`,
    recommendedParams: {
      model: "Seedream 4.0",
      ratio: data.recommendedParams?.ratio || "1024x1024 / 1:1",
      negativePrompt,
    },
  };
}

function getUserPrompt(payload) {
  if (!payload || typeof payload !== "object") return "";
  return String(payload.userPrompt || "").trim();
}

function getRequestPayload(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

const systemPrompt = [
  "你是专业的AI图像生成优化助手，面向即梦等图像生成平台。",
  "你要做4件事：场景识别、问题分析、方案建议、提示词优化。",
  "推荐参数里的模型统一输出：Seedream 4.0。",
  "必须同时输出正向提示词和负向提示词，并且文本开头要明确写'正向提示词：'与'负向提示词：'。",
  "输出必须是JSON，字段严格如下：",
  '{"sceneType":"风格转绘|主体替换|同风格改编|纯文本生成","confidence":0-100,"analysisResult":{"problems":["..."],"strengths":["..."]},"solutions":["..."],"positivePrompt":"...","negativePrompt":"...","optimizedPrompt":"正向提示词：...\\n\\n负向提示词：...","recommendedParams":{"model":"Seedream 4.0","ratio":"...","negativePrompt":"..."}}',
  "要求：中文输出，problems/strengths/solutions各2-4条，可执行，不空泛。",
].join("\n");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    return;
  }

  const payload = getRequestPayload(req);
  const userPrompt = getUserPrompt(payload);
  if (!userPrompt) {
    sendJson(res, 400, { error: "缺少 userPrompt" });
    return;
  }

  const API_KEY = process.env.OPENAI_API_KEY || process.env.API_KEY;
  const API_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const APP_URL = process.env.OPENROUTER_APP_URL || process.env.APP_URL || "https://example.com";
  const APP_NAME = process.env.OPENROUTER_APP_NAME || process.env.APP_NAME || "Image Prompt Optimizer MVP";

  if (!API_KEY) {
    sendJson(res, 200, {
      ...fallbackResponse(),
      _warning: "未检测到 OPENAI_API_KEY，已返回本地降级结果",
    });
    return;
  }

  try {
    const userContent = [{ type: "text", text: userPrompt }];

    const referenceImageInput = payload.referenceImageUrl || payload.referenceImageDataUrl;
    const generatedImageInput = payload.generatedImageUrl || payload.generatedImageDataUrl;

    if (referenceImageInput) {
      userContent.push({ type: "text", text: "这是参考图，请用于风格/构图比对。" });
      userContent.push({
        type: "image_url",
        image_url: { url: referenceImageInput },
      });
    }

    if (generatedImageInput) {
      userContent.push({ type: "text", text: "这是生成图，是你要重点分析的问题图。" });
      userContent.push({
        type: "image_url",
        image_url: { url: generatedImageInput },
      });
    }

    const body = {
      model: MODEL,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    };

    const resp = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": APP_URL,
        "X-Title": APP_NAME,
        "X-OpenRouter-Title": APP_NAME,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      sendJson(res, 502, { error: `LLM调用失败(${resp.status}) ${text}` });
      return;
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      sendJson(res, 502, { error: "LLM未返回内容" });
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      sendJson(res, 502, { error: "LLM返回非JSON格式" });
      return;
    }

    sendJson(res, 200, normalizeResult(parsed));
  } catch (err) {
    sendJson(res, 500, { error: err?.message || "服务异常" });
  }
};
