import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #170 — api/_lib/ai.js, the ONE Anthropic gateway. Unit tests with a mocked
 * @anthropic-ai/sdk (never the real API): the UNCONFIGURED error path, the
 * PROVIDER_FAILED mapping, the max_tokens cap, and the text/usage return.
 */

const requireFromHere = createRequire(import.meta.url);
const sdkPath = requireFromHere.resolve("@anthropic-ai/sdk");
const aiPath = requireFromHere.resolve("../../../api/_lib/ai.js");

type CreateArgs = {
  model: string;
  max_tokens: number;
  system?: string;
  messages: unknown[];
};

let createCalls: CreateArgs[];
let createImpl: (args: CreateArgs) => Promise<unknown>;

type AiModule = {
  AiError: new (code: string, message: string) => Error & { code: string };
  isAiConfigured: () => boolean;
  aiComplete: (opts: {
    system?: string;
    messages: Array<{ role: string; content: unknown }>;
    model?: string;
    maxTokens?: number;
  }) => Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } | null; model: string }>;
  MAX_TOKENS_CAP: number;
  DEFAULT_MAX_TOKENS: number;
};

function loadAi(): AiModule {
  delete requireFromHere.cache[aiPath];
  return requireFromHere(aiPath) as AiModule;
}

beforeEach(() => {
  createCalls = [];
  createImpl = async () => ({
    content: [{ type: "text", text: "a grounded summary" }],
    usage: { input_tokens: 100, output_tokens: 20 },
    model: "claude-sonnet-4-6",
  });

  class FakeAnthropic {
    messages = {
      create: async (args: CreateArgs) => {
        createCalls.push(args);
        return createImpl(args);
      },
    };
  }
  requireFromHere.cache[sdkPath] = {
    id: sdkPath,
    filename: sdkPath,
    loaded: true,
    exports: { default: FakeAnthropic },
  } as NodeJS.Module;

  process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake";
  delete process.env.ASSISTANT_AI_MODEL;
});

afterEach(() => {
  delete requireFromHere.cache[sdkPath];
  delete requireFromHere.cache[aiPath];
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ASSISTANT_AI_MODEL;
  vi.restoreAllMocks();
});

describe("isAiConfigured", () => {
  it("is false without ANTHROPIC_API_KEY, true with it", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const ai = loadAi();
    expect(ai.isAiConfigured()).toBe(false);
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake";
    expect(ai.isAiConfigured()).toBe(true);
  });
});

describe("aiComplete", () => {
  it("throws AiError(UNCONFIGURED) without a key — never a fake completion", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const ai = loadAi();
    await expect(
      ai.aiComplete({ messages: [{ role: "user", content: "hi" }] })
    ).rejects.toMatchObject({ name: "AiError", code: "UNCONFIGURED" });
    expect(createCalls).toHaveLength(0);
  });

  it("maps a provider/SDK failure to AiError(PROVIDER_FAILED)", async () => {
    createImpl = async () => {
      throw new Error("overloaded_error: try again");
    };
    const ai = loadAi();
    await expect(
      ai.aiComplete({ messages: [{ role: "user", content: "hi" }] })
    ).rejects.toMatchObject({ name: "AiError", code: "PROVIDER_FAILED" });
  });

  it("returns joined text blocks + mapped usage on success", async () => {
    createImpl = async () => ({
      content: [
        { type: "text", text: "part one" },
        { type: "tool_use", id: "x" },
        { type: "text", text: "part two" },
      ],
      usage: { input_tokens: 42, output_tokens: 7 },
      model: "claude-sonnet-4-6",
    });
    const ai = loadAi();
    const out = await ai.aiComplete({
      system: "be grounded",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 300,
    });
    expect(out.text).toBe("part one\npart two");
    expect(out.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
    expect(out.model).toBe("claude-sonnet-4-6");
    expect(createCalls[0]!.system).toBe("be grounded");
    expect(createCalls[0]!.max_tokens).toBe(300);
  });

  it("caps max_tokens at MAX_TOKENS_CAP and defaults when unset", async () => {
    const ai = loadAi();
    await ai.aiComplete({ messages: [{ role: "user", content: "a" }], maxTokens: 999_999 });
    expect(createCalls[0]!.max_tokens).toBe(ai.MAX_TOKENS_CAP);
    await ai.aiComplete({ messages: [{ role: "user", content: "b" }] });
    expect(createCalls[1]!.max_tokens).toBe(ai.DEFAULT_MAX_TOKENS);
  });

  it("honours the ASSISTANT_AI_MODEL env override and per-call model", async () => {
    process.env.ASSISTANT_AI_MODEL = "claude-haiku-4-5";
    const ai = loadAi();
    await ai.aiComplete({ messages: [{ role: "user", content: "a" }] });
    expect(createCalls[0]!.model).toBe("claude-haiku-4-5");
    await ai.aiComplete({ messages: [{ role: "user", content: "b" }], model: "claude-opus-4-6" });
    expect(createCalls[1]!.model).toBe("claude-opus-4-6");
  });

  it("rejects an empty messages array instead of calling the provider", async () => {
    const ai = loadAi();
    await expect(ai.aiComplete({ messages: [] })).rejects.toMatchObject({
      code: "PROVIDER_FAILED",
    });
    expect(createCalls).toHaveLength(0);
  });
});
