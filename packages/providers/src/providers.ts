import { AnthropicProvider, type AnthropicAuth } from "./anthropic.js";
import { DemoProvider } from "./demo.js";
import { OpenAICompatProvider } from "./openai-compatible.js";
import type { Provider } from "@ribhu-voyager/engine";

type Compat = {
  baseUrl: string;
  baseUrlEnv?: string;
  keyEnv?: string;
  key?: string;
  headers?: Record<string, string>;
};

const COMPAT: Record<string, Compat> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    baseUrlEnv: "OPENAI_BASE_URL",
    keyEnv: "OPENAI_API_KEY",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    keyEnv: "DEEPSEEK_API_KEY",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
  },
  xai: {
    baseUrl: "https://api.x.ai/v1",
    keyEnv: "XAI_API_KEY",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    keyEnv: "MISTRAL_API_KEY",
  },
  ollama: {
    baseUrl: "http://127.0.0.1:11434/v1",
    baseUrlEnv: "OLLAMA_BASE_URL",
    key: "ollama",
  },
};

export type ProviderOptions = {
  provider: string;
  model: string;
  getAnthropicAuth: () => Promise<AnthropicAuth>;
  env?: NodeJS.ProcessEnv;
};

export function createProvider(options: ProviderOptions): Provider {
  const env = options.env ?? process.env;
  if (options.provider === "demo") {
    return new DemoProvider(options.model);
  }
  if (options.provider === "anthropic") {
    return new AnthropicProvider({
      model: options.model,
      getAuth: options.getAnthropicAuth,
      baseUrl: env.ANTHROPIC_BASE_URL?.trim() || undefined,
    });
  }

  const compat = COMPAT[options.provider];
  if (!compat) {
    throw new Error(`Unsupported RIBBHU_PROVIDER: ${options.provider}`);
  }
  const apiKey =
    compat.key ??
    (compat.keyEnv ? env[compat.keyEnv]?.trim() : undefined) ??
    "";
  if (compat.keyEnv && apiKey === "") {
    throw new Error(
      `RIBBHU_PROVIDER=${options.provider} requires ${compat.keyEnv}.`,
    );
  }

  return new OpenAICompatProvider({
    id: options.provider,
    model: options.model,
    baseUrl:
      (compat.baseUrlEnv ? env[compat.baseUrlEnv]?.trim() : undefined) ||
      compat.baseUrl,
    apiKey,
    headers: compat.headers,
  });
}
