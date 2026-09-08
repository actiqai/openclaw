type CustomEntryLike = { type?: unknown; customType?: unknown; data?: unknown };

export const CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";

export type CacheTtlEntryData = {
  timestamp: number;
  provider?: string;
  modelId?: string;
};

/**
 * Считает ли этот провайдер кэш по правилам Anthropic.
 *
 * Решает объявленный API, а не имя провайдера. Имя — это то, как пользователь назвал
 * запись в своём конфиге, и опираться на него значит отключать обрезку контекста для
 * каждого прокси к тому же самому API. Так и вышло: провайдер, указывающий на
 * собственный шлюз перед Anthropic, в список имён не попадал, обрезка не включалась
 * ни разу, и заметить это было нечем — предикат возвращает `false` молча, а
 * расширение просто не грузится.
 *
 * Имена оставлены как запасной путь для конфигов без явного `api`.
 */
export function isCacheTtlEligibleProvider(
  provider: string,
  modelId: string,
  api?: string,
): boolean {
  if (api?.toLowerCase() === "anthropic-messages") {
    return true;
  }

  const normalizedProvider = provider.toLowerCase();
  const normalizedModelId = modelId.toLowerCase();
  if (normalizedProvider === "anthropic") {
    return true;
  }
  if (normalizedProvider === "openrouter" && normalizedModelId.startsWith("anthropic/")) {
    return true;
  }
  return false;
}

export function readLastCacheTtlTimestamp(sessionManager: unknown): number | null {
  const sm = sessionManager as { getEntries?: () => CustomEntryLike[] };
  if (!sm?.getEntries) {
    return null;
  }
  try {
    const entries = sm.getEntries();
    let last: number | null = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type !== "custom" || entry?.customType !== CACHE_TTL_CUSTOM_TYPE) {
        continue;
      }
      const data = entry?.data as Partial<CacheTtlEntryData> | undefined;
      const ts = typeof data?.timestamp === "number" ? data.timestamp : null;
      if (ts && Number.isFinite(ts)) {
        last = ts;
        break;
      }
    }
    return last;
  } catch {
    return null;
  }
}

export function appendCacheTtlTimestamp(sessionManager: unknown, data: CacheTtlEntryData): void {
  const sm = sessionManager as {
    appendCustomEntry?: (customType: string, data: unknown) => void;
  };
  if (!sm?.appendCustomEntry) {
    return;
  }
  try {
    sm.appendCustomEntry(CACHE_TTL_CUSTOM_TYPE, data);
  } catch {
    // ignore persistence failures
  }
}
