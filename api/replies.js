import { OPERATOR_SYSTEM_PROMPT, checkDraft } from "./_rules.js";

const MODEL = "gemini-2.5-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function send(res, status, payload) {
  for (const [name, value] of Object.entries(CORS)) res.setHeader(name, value);
  res.setHeader("Content-Type", "application/json");
  res.status(status).send(JSON.stringify(payload));
}

async function askGemini(key, prompt) {
  const response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: OPERATOR_SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 1, maxOutputTokens: 300 },
      safetySettings: [
        "HARM_CATEGORY_HARASSMENT",
        "HARM_CATEGORY_HATE_SPEECH",
        "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        "HARM_CATEGORY_DANGEROUS_CONTENT",
      ].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" })),
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    const error = new Error(`Gemini request failed (${response.status}): ${body}`);
    error.status = response.status;
    throw error;
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("Gemini returned a response that could not be read.");
  }

  const parts = json?.candidates?.[0]?.content?.parts || [];
  return parts
    .map((part) => part?.text || "")
    .join("")
    .trim()
    .replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, "")
    .trim();
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    for (const [name, value] of Object.entries(CORS)) res.setHeader(name, value);
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return send(res, 405, { error: "Use POST." });
  }

  let payload = req.body;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = null;
    }
  }

  const conversation = String(payload?.conversation || "").trim();
  if (conversation.length < 20 || conversation.length > 12000) {
    return send(res, 400, {
      error: "Send { conversation } with at least 20 characters of visible chat.",
    });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return send(res, 500, {
      error: "GEMINI_API_KEY is not set on this deployment. Add it in Vercel and redeploy.",
    });
  }

  const tone = String(payload?.tone || "warm, playful and natural").slice(0, 200);
  const goal = String(
    payload?.goal || "answer his questions and keep the conversation going",
  ).slice(0, 300);
  const lengthNote = String(payload?.length || "").slice(0, 100);

  try {
    let draft = "";
    let check = { ok: false, issues: [] };
    let feedback = "";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const prompt = [
        `Tone: ${tone}. Goal: ${goal}.`,
        lengthNote ? `Length note: ${lengthNote}.` : "",
        "",
        "Conversation so far (oldest first):",
        "",
        conversation.slice(-8000),
        "",
        feedback
          ? `Your previous attempt broke the rules: ${feedback}. Rewrite it completely so it follows every rule.`
          : "",
        "Write the next message.",
      ]
        .filter(Boolean)
        .join("\n");

      draft = await askGemini(key, prompt);
      check = checkDraft(draft);
      if (check.ok) break;
      feedback = check.issues.join("; ");
    }

    if (!draft) {
      return send(res, 502, { error: "The model returned an empty reply. Try again." });
    }

    return send(res, 200, {
      drafts: [draft],
      compliant: check.ok,
      warnings: check.issues,
      characters: draft.length,
    });
  } catch (error) {
    const status = error?.status;
    const message = String(error?.message || error);
    if (status === 429) {
      return send(res, 429, {
        error: "Google rate limited the free tier. Wait a moment and try again.",
      });
    }
    if (status === 400 || status === 403) {
      return send(res, status, {
        error: "Google rejected the API key. Check GEMINI_API_KEY in your Vercel project settings.",
      });
    }
    console.error(message);
    return send(res, 502, { error: "The AI request failed. Try again." });
  }
}
