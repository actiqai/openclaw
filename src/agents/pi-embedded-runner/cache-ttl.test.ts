import { describe, expect, it } from "vitest";
import { isCacheTtlEligibleProvider } from "./cache-ttl.js";

describe("isCacheTtlEligibleProvider", () => {
  it("accepts the first-party provider", () => {
    expect(isCacheTtlEligibleProvider("anthropic", "claude-haiku-4-5")).toBe(true);
  });

  it("accepts openrouter only for Anthropic models", () => {
    expect(isCacheTtlEligibleProvider("openrouter", "anthropic/claude-haiku-4-5")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "openai/gpt-4o")).toBe(false);
  });

  // Это и есть починка. Провайдер, указывающий на собственный шлюз перед Anthropic,
  // называется как угодно — по имени он в список не попадал, и обрезка контекста не
  // включалась ни разу. Заметить было нечем: предикат возвращает false молча, а
  // расширение просто не грузится, не оставляя ни строки в логе.
  it("accepts any provider that declares the Anthropic Messages API", () => {
    expect(isCacheTtlEligibleProvider("my-gateway", "claude-haiku-4-5", "anthropic-messages")).toBe(
      true,
    );
    expect(isCacheTtlEligibleProvider("MY-GATEWAY", "claude-haiku-4-5", "Anthropic-Messages")).toBe(
      true,
    );
  });

  it("does not accept a provider whose API is something else", () => {
    expect(isCacheTtlEligibleProvider("my-gateway", "gpt-4o", "openai-completions")).toBe(false);
  });

  // Имя как запасной путь: конфиг без явного `api` не должен потерять то, что
  // работало до этой правки.
  it("still falls back to names when the API is not declared", () => {
    expect(isCacheTtlEligibleProvider("anthropic", "claude-haiku-4-5", undefined)).toBe(true);
    expect(isCacheTtlEligibleProvider("some-proxy", "claude-haiku-4-5", undefined)).toBe(false);
  });
});
