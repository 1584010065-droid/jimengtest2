const http = require("http");
const fs = require("fs");
const path = require("path");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.OPENAI_API_KEY || process.env.API_KEY;
const API_BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const APP_URL = process.env.OPENROUTER_APP_URL || process.env.APP_URL || "http://localhost:8787";
const APP_NAME = process.env.OPENROUTER_APP_NAME || process.env.APP_NAME || "Image Prompt Optimizer MVP";
const PROXY_URL =
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.ALL_PROXY ||
  process.env.https_proxy ||
  process.env.http_proxy ||
  process.env.all_proxy;

if (PROXY_URL) {
  // Node.js built-in fetch can honor *_PROXY when NODE_USE_ENV_PROXY=1
  process.env.NODE_USE_ENV_PROXY = "1";
}

const htmlPath = path.join(__dirname, "新建 文本文档.html");

const PRODUCT_SCENE_TYPES = new Set(["风格转绘", "主体替换", "同风格改编", "纯文本生成"]);

function mapRouteToSceneType(sceneRoute, fallback = "纯文本生成") {
  const route = String(sceneRoute || "").trim();
  if (route.includes("风格与材质转绘")) return "风格转绘";
  if (route.includes("结构与版式保留")) return "同风格改编";
  if (route.includes("主体替换与背景融合")) return "主体替换";
  if (route.includes("局部编辑与重绘")) return "主体替换";
  if (route.includes("概念参考与延展")) return "同风格改编";
  return fallback;
}

function normalizeSceneType(rawSceneType, rawSceneRoute) {
  const sceneType = String(rawSceneType || "").trim();
  if (PRODUCT_SCENE_TYPES.has(sceneType)) return sceneType;
  if (sceneType.includes("风格与材质转绘")) return "风格转绘";
  if (sceneType.includes("结构与版式保留")) return "同风格改编";
  if (sceneType.includes("主体替换与背景融合")) return "主体替换";
  if (sceneType.includes("局部编辑与重绘")) return "主体替换";
  if (sceneType.includes("概念参考与延展")) return "同风格改编";
  if (sceneType.includes("纯文本")) return "纯文本生成";
  return mapRouteToSceneType(rawSceneRoute, "纯文本生成");
}

const systemPrompt = [
  "你是部署在企业级AIGC工作流中的图像生成优化路由助手，服务于即梦等图像生成平台。",
  "你要做4件事：场景识别、问题分析、方案建议、提示词优化，并确保提示词可直接用于生图。",
  "任务字典硬约束（按sceneRoute执行可变量/不变量/禁改项）：",
  "1风格与材质转绘 不变量=轮廓/构图/透视/拓扑；可变量=材质/媒介/光影/色彩；禁改=重排构图和改拓扑。",
  "2结构与版式保留 不变量=版式骨架/层级/文字框位置比例/主风格锚点；可变量=文案语义与局部元素；禁改=改版式或跨媒介风格漂移。",
  "3主体替换与背景融合 不变量=背景几何透视与风格锚点（未要求改背景时）；可变量=主体身份服饰动作；禁改=擅自重做背景。",
  "4局部编辑与重绘 不变量=非编辑区全部视觉资产；可变量=编辑区指定元素；禁改=全局重绘与编辑区外形变。",
  "5概念参考与延展 不变量=至少继承3个风格锚点；可变量=主体场景叙事；禁改=完全脱离参考风格。",
  "执行规则：先生成保留项/替换项/禁用项；若positivePrompt违反不变量或触发禁改项，必须重写后再输出。",
  "分析协议：Step1视觉资产剥离（构图/透视/版式为高优先保留，主体/地标/国家符号/文案语义为可变）；Step1.3风格锚点提取（媒介/笔触/边缘/饱和度/纹理/光影键值）；Step1.5语义替换映射（保留项/替换项/禁用项）；Step1.6符号归因去耦（Form/Function/Identity分离，跨主题只继承Form与Function）；Step1.8主题一致性矩阵（Target优先，Source仅作参考）。",
  "新增Step1.9身份风险分级：高显著且可能承载国家/城市身份的符号，IdentityRisk=high，跨主题时按身份符号处理。",
  "Step3必须执行风格优先级锁：positivePrompt开头先写风格锚点，再写主体与场景；若主风格是插画/油画/粉彩等非摄影媒介，禁止混入photorealistic或cinematic photo。",
  "Step4必须执行风格冲突审查：若同时出现'手绘插画'与'电影感摄影'等媒介冲突词，删除次级风格词，仅保留主风格。",
  "若符号存在归因歧义，采用二选一策略：A替换为目标主题等价符号；B删除并用其他构图元素补偿视觉平衡。",
  "对high风险符号，禁止抽象化保留（如仅改称'抽象圆盘'）；必须明确替换或删除。",
  "若用户指定目标城市或国家，源主题地标、国旗符号、源城市文案必须替换或禁用，除非用户明确要求保留。",
  "跨主题改编只继承风格层（构图、色调、颗粒、排版节奏、镜头语言），不得继承身份层（国家符号、源地标、源城市文案）。",
  "输出前必须执行主题冲突审查：positivePrompt允许出现文化来源词，但不得同时含目标主题与异主题冲突身份符号；若冲突必须重写。",
  "当sceneRoute为3或4且用户未明确要求改背景时，默认保留参考图背景风格与透视关系，仅替换主体或局部元素。",
  "非文字场景禁止输出乱码类负向词（garbled text, illegible text, typo, broken letters, distorted typography）。",
  "negativePrompt必须包含至少2个风格漂移抑制词（如 photorealistic, 3d render, smooth digital illustration, flat vector, clean line art）。",
  "负向提示词必须包含风险收敛词，跨主题场景需包含源主题残留抑制词（source city landmarks, national flag symbol, wrong city text, mixed cultural symbols）。",
  "你必须先输出sceneRoute（5类精细路由），再输出sceneType（4类产品标签）。sceneType必须由sceneRoute映射得到，不可自造标签。",
  "映射规则：1风格与材质转绘->风格转绘；2结构与版式保留->同风格改编；3主体替换与背景融合->主体替换；4局部编辑与重绘->主体替换；5概念参考与延展->同风格改编（无参考图时可用纯文本生成）。",
  "输出必须是JSON，字段严格如下：",
  '{"sceneRoute":"1.风格与材质转绘|2.结构与版式保留|3.主体替换与背景融合|4.局部编辑与重绘|5.概念参考与延展","sceneType":"风格转绘|主体替换|同风格改编|纯文本生成","confidence":0-100,"analysisResult":{"problems":["..."],"strengths":["..."]},"solutions":["..."],"positivePrompt":"...","negativePrompt":"...","optimizedPrompt":"正向提示词：...\\n\\n负向提示词：...","recommendedParams":{"model":"Seedream 4.0","ratio":"...","negativePrompt":"..."}}',
  "要求：中文输出，problems/strengths/solutions各2-4条，可执行，不空泛。",
].join("\n");

function sendJson(res, code, data) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(data));
}

function sendHtml(res) {
  const html = fs.readFileSync(htmlPath, "utf8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 12 * 1024 * 1024) {
        reject(new Error("请求过大，请压缩图片后再试"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error("JSON格式错误"));
      }
    });
    req.on("error", reject);
  });
}

function fallbackResponse(prompt) {
  return {
    sceneRoute: "5. 概念参考与延展",
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
    optimizedPrompt:
      "主体清晰描述, 环境细节明确, cinematic composition, low-angle shot, rich texture, soft volumetric lighting, color harmony, ultra detailed, 8k",
    recommendedParams: {
      model: "高质量图像模型",
      ratio: "1024x1536 / 2:3",
      negativePrompt: "text, watermark, low quality, blurry, bad anatomy",
    },
  };
}

function normalizeResult(raw, prompt) {
  const data = raw && typeof raw === "object" ? raw : {};
  const sceneRoute = String(data.sceneRoute || data.taskRoute || data.task_route || "").trim();
  const sceneType = normalizeSceneType(data.sceneType, sceneRoute);
  return {
    sceneRoute: sceneRoute || "5. 概念参考与延展",
    sceneType,
    confidence: Math.max(1, Math.min(100, Number(data.confidence || 75))),
    analysisResult: {
      problems: Array.isArray(data.analysisResult?.problems)
        ? data.analysisResult.problems.slice(0, 4)
        : fallbackResponse(prompt).analysisResult.problems,
      strengths: Array.isArray(data.analysisResult?.strengths)
        ? data.analysisResult.strengths.slice(0, 4)
        : fallbackResponse(prompt).analysisResult.strengths,
    },
    solutions: Array.isArray(data.solutions)
      ? data.solutions.slice(0, 4)
      : fallbackResponse(prompt).solutions,
    optimizedPrompt: data.optimizedPrompt || fallbackResponse(prompt).optimizedPrompt,
    recommendedParams: {
      model: data.recommendedParams?.model || "通用图像模型",
      ratio: data.recommendedParams?.ratio || "1024x1024 / 1:1",
      negativePrompt:
        data.recommendedParams?.negativePrompt || "text, watermark, low quality",
    },
  };
}

async function callLLM(payload) {
  const userContent = [{ type: "text", text: payload.userPrompt || "" }];

  if (payload.referenceImageDataUrl) {
    userContent.push({
      type: "text",
      text: "这是参考图，请用于风格/构图比对。",
    });
    userContent.push({
      type: "image_url",
      image_url: { url: payload.referenceImageDataUrl },
    });
  }

  if (payload.generatedImageDataUrl) {
    userContent.push({
      type: "text",
      text: "这是生成图，是你要重点分析的问题图。",
    });
    userContent.push({
      type: "image_url",
      image_url: { url: payload.generatedImageDataUrl },
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
    throw new Error(`LLM调用失败(${resp.status}) ${text}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("LLM未返回内容");
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error("LLM返回非JSON格式");
  }

  return normalizeResult(parsed, payload.userPrompt);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    sendHtml(res);
    return;
  }

  if (req.method === "POST" && req.url === "/api/analyze") {
    try {
      const payload = await parseBody(req);
      if (!payload.userPrompt || !String(payload.userPrompt).trim()) {
        sendJson(res, 400, { error: "缺少 userPrompt" });
        return;
      }

      if (!API_KEY) {
        sendJson(res, 200, {
          ...fallbackResponse(payload.userPrompt),
          _warning: "未检测到 OPENAI_API_KEY，已返回本地降级结果",
        });
        return;
      }

      const result = await callLLM(payload);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: err.message || "服务异常" });
    }
    return;
  }

  sendJson(res, 404, { error: "Not Found" });
});

server.listen(PORT, () => {
  console.log(`MVP 服务已启动: http://localhost:${PORT}`);
  console.log(`模型: ${MODEL}`);
  console.log(API_KEY ? "API_KEY: 已检测" : "API_KEY: 未检测到（将使用降级分析）");
});
