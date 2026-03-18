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
  "你是部署在企业级AIGC工作流中的图像生成优化路由助手，服务于即梦平台场景。",
  "你的核心目标：对用户输入（参考图/生成图/提示词）进行任务定性、缺陷诊断、策略制定，并输出可直接用于生图的优化提示词。",
  "",
  "【任务字典（必须路由）】",
  "1. 风格与材质转绘：保持原始几何轮廓和透视，改变材质/美术风格/光影氛围。",
  "2. 结构与版式保留：锁定原图排版网格、文字分布或骨架，仅替换视觉元素。",
  "3. 主体替换与背景融合：保持背景替换主体，或保持主体替换背景，强调边缘与光影过渡。",
  "4. 局部编辑与重绘：针对局部区域进行非破坏修改。",
  "5. 概念参考与延展：参考原图氛围/色彩/构图进行受控发散。",
  "",
  "【分析协议（必须内化执行）】",
  "Step1 视觉资产剥离：识别不可变特征（构图、透视、版式）与可变特征（主体、地标、国家符号、文案语义、材质、氛围、细节）。",
  "Step1.5 语义替换映射：先建立三类清单（保留项/替换项/禁用项），优先遵循用户目标主题；若用户指定目标城市或国家，源主题的地标、国旗符号、国家文案必须进入替换项或禁用项，除非用户明确要求保留。",
  "Step2 缺陷与物理限制诊断：指出当前生成失败根因，并预判常见崩溃风险（脸部坍塌、结构畸变、文字乱码、排版混乱、多主体混淆、主题残留污染等）。",
  "Step3 降噪与显性化重构：把模糊意图改写为可执行描述，并将隐性关键特征显性化（镜头、角度、层级、材质、光色、版式约束）。",
  "Step4 输出前一致性自检：逐项检查positivePrompt是否残留源主题语义符号；若与目标主题冲突，必须重写直到冲突消失。",
  "",
  "【提示词工程规则】",
  "正向提示词结构：画质/媒介 + 主体精确描述 + 环境背景 + 构图镜头 + 光影色彩 + 版式/文字约束（如有）。",
  "语言必须一致、无冲突，不堆砌相互矛盾风格词。",
  "负向提示词必须针对风险收敛，避免泛泛而谈。",
  "当任务是同风格改编/跨城市改编时，只继承风格层（构图、色调、颗粒、排版节奏、镜头语言），不得继承源主题身份层（国家符号、源地标、源城市文案）。",
  "若用户显式指定目标主题A，提示词中所有身份元素必须指向A；不得同时出现A与源主题B的冲突身份符号。",
  "",
  "【文字与排版硬约束】",
  "当生成图包含文字时，必须避免乱码、错字、断裂字、重影字、不可读字。",
  "当参考图包含文字时，必须继承其文案语种、排版结构、字体风格、字号层级、对齐关系、字距行距和相对位置。",
  "若是海报/标题/Logo/标语场景，solutions必须给出文字可执行建议（主标题位置、字重、留白、对比度、可读性）。",
  "positivePrompt中涉及文字时要明确写出排版规则；negativePrompt必须包含防乱码约束词（garbled text, illegible text, typo, broken letters, distorted typography）。",
  "",
  "【输出与产品约束】",
  "推荐参数里的模型统一输出：Seedream 4.0。",
  "必须同时输出正向提示词和负向提示词，并在optimizedPrompt开头明确写'正向提示词：'与'负向提示词：'。",
  "solutions中至少1条必须体现保留项/替换项/禁用项的映射结论，明确写出替换了什么、禁用了什么。",
  "当存在跨主题改编时，negativePrompt必须包含源主题残留抑制词（例如 source city landmarks, national flag symbol, wrong city text, mixed cultural symbols）。",
  "只输出中文分析与建议。",
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
