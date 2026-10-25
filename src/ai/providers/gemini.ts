import { aiScoreSchema, type AiScore } from "../types.js";
import { ProviderError, type LlmProvider, type LlmProviderConfig, type ScoreRequest } from "../provider.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Structured-output schema (Google `responseSchema`, an OpenAPI subset). */
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    score: { type: "INTEGER" },
    decision: { type: "STRING", enum: ["KEEP", "REJECT"] },
    confidence: { type: "INTEGER" },
    workplace: { type: "STRING", enum: ["remote", "hybrid", "onsite", "unknown"] },
    visa: { type: "STRING", enum: ["sponsors", "unknown", "no_sponsorship"] },
    missing_critical_requirements: { type: "ARRAY", items: { type: "STRING" } },
    reason: { type: "STRING" },
  },
  required: [
    "score",
    "decision",
    "confidence",
    "workplace",
    "visa",
    "missing_critical_requirements",
    "reason",
  ],
} as const;

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  error?: { message?: string };
}

/**
 * Google AI Studio (Generative Language API) provider. Uses the REST endpoint directly so the
 * worker needs no extra SDK; the API key is sent as a query parameter as documented.
 */
export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: LlmProviderConfig) {
    if (!config.apiKey) {
      throw new Error("GeminiProvider requires an API key (GEMINI_API_KEY).");
    }
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async score(request: ScoreRequest): Promise<AiScore> {
    const url = `${API_BASE}/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const body = {
      contents: [{ parts: [{ text: request.prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ProviderError(`gemini ${response.status}: ${detail.slice(0, 300)}`, response.status);
    }

    const data = (await response.json()) as GeminiResponse;
    const text =
      data.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("")
        .trim() ?? "";

    if (!text) {
      const reason = data.candidates?.[0]?.finishReason;
      throw new Error(`gemini: empty response${reason ? ` (finishReason=${reason})` : ""}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`gemini: response was not valid JSON: ${text.slice(0, 200)}`);
    }

    return aiScoreSchema.parse(parsed);
  }
}
