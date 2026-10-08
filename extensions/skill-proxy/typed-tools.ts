/**
 * Типизированные инструменты скиллов (`CLT-060`, гейтвей — `GTW-040`).
 *
 * `call_skill(skill, action, params)` принимает что угодно: имя действия и
 * параметры модель берёт из текста SKILL.md, и опечатка видна только отказом
 * гейтвея. Для скилла с описанием регистрируется свой инструмент —
 * `yandex_disk(action, path, query)` — с перечнем действий и типами. Описание
 * то же, по которому гейтвей проверяет вызов: тип известен с обеих сторон.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ToolParam = {
  type: "string" | "integer" | "number" | "boolean";
  description: string;
  enum?: string[];
  minLength?: number;
  minimum?: number;
  maximum?: number;
};

export type ToolAction = {
  description: string;
  params: Record<string, ToolParam>;
  required?: string[];
};

export type ToolSpec = {
  skill: string;
  tool: string;
  description: string;
  actions: Record<string, ToolAction>;
};

type Catalog = { digest: string; tools: ToolSpec[] };

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: null;
};

type Logger = { info: (msg: string) => void; warn?: (msg: string) => void };

// Имя инструмента приходит по сети — пускаем только то, что заведомо не
// перекроет встроенные инструменты агента и не сломает их список.
const TOOL_NAME = /^[a-z][a-z0-9_]{1,40}$/;
const RESERVED = new Set([
  "call_skill",
  "skill_state",
  "message",
  "exec",
  "read",
  "write",
  "web_search",
]);

// Раз в десять минут: описание меняется только с выкатом гейтвея.
const REFRESH_MS = 10 * 60_000;

/**
 * JSON Schema инструмента. Параметры всех действий сливаются в одну схему —
 * провайдеры моделей плохо переносят `oneOf` на верхнем уровне, — а какому
 * действию что нужно, сказано в описаниях. Гейтвей всё равно проверит вызов
 * по действию и вернёт имя поля, если модель ошиблась.
 */
export function toolSchema(spec: ToolSpec): Record<string, unknown> {
  const actions = Object.keys(spec.actions).sort();
  const properties: Record<string, unknown> = {
    action: {
      type: "string",
      enum: actions,
      description: actions.map((name) => `${name} — ${spec.actions[name].description}`).join("; "),
    },
  };

  for (const name of actions) {
    const action = spec.actions[name];

    for (const [param, p] of Object.entries(action.params ?? {})) {
      const required = action.required?.includes(param) ? `обязателен для ${name}` : `для ${name}`;
      const existing = properties[param] as { description: string } | undefined;

      if (existing) {
        existing.description += `; ${required}`;
        continue;
      }

      const schema: Record<string, unknown> = {
        type: p.type,
        description: `${p.description} (${required})`,
      };
      if (p.enum) schema.enum = p.enum;
      if (p.minLength) schema.minLength = p.minLength;
      if (p.minimum !== undefined) schema.minimum = p.minimum;
      if (p.maximum !== undefined) schema.maximum = p.maximum;

      properties[param] = schema;
    }
  }

  return { type: "object", properties, required: ["action"], additionalProperties: false };
}

export function typedTool(
  spec: ToolSpec,
  call: (skill: string, action: string, params: Record<string, unknown>) => Promise<ToolResult>,
) {
  return {
    label: spec.tool,
    name: spec.tool,
    description:
      `${spec.description}\n` +
      "Returns the real results of the platform skill. NEVER invent results; report only what it returns. " +
      'If the answer has status "error" with "errors", fix the named fields and call again.',
    // JSON Schema напрямую: TypeBox и есть JSON Schema, агенту нужен только объект.
    parameters: toolSchema(spec) as never,
    execute: async (_toolCallId: string, args: Record<string, unknown>): Promise<ToolResult> => {
      const { action, ...params } = args;

      return call(spec.skill, String(action ?? ""), params);
    },
  };
}

function valid(catalog: unknown): catalog is Catalog {
  if (!catalog || typeof catalog !== "object") return false;
  const tools = (catalog as Catalog).tools;

  return Array.isArray(tools);
}

function usable(tools: ToolSpec[]): ToolSpec[] {
  const seen = new Set<string>();

  return tools.filter((spec) => {
    const ok =
      typeof spec?.skill === "string" &&
      TOOL_NAME.test(spec.tool) &&
      !RESERVED.has(spec.tool) &&
      !seen.has(spec.tool) &&
      spec.actions !== null &&
      typeof spec.actions === "object" &&
      Object.keys(spec.actions).length > 0;

    if (ok) seen.add(spec.tool);

    return ok;
  });
}

export function createToolCatalog(opts: {
  gatewayBaseUrl: string;
  instanceToken: string;
  cacheFile: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}) {
  let catalog: Catalog = { digest: "", tools: [] };

  try {
    if (existsSync(opts.cacheFile)) {
      const cached: unknown = JSON.parse(readFileSync(opts.cacheFile, "utf8"));
      if (valid(cached)) catalog = { digest: cached.digest, tools: usable(cached.tools) };
    }
  } catch (err) {
    opts.logger.warn?.(`skill-proxy: tool cache unreadable: ${String(err)}`);
  }

  const refresh = async () => {
    // Без токена гейтвей не отдаст описание — и не примет вызовы скиллов с
    // подключением; остаётся общий `call_skill`.
    if (!opts.instanceToken) return;

    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-Instance-Token": opts.instanceToken,
    };
    if (catalog.digest) headers["If-None-Match"] = catalog.digest;

    try {
      const response = await (opts.fetchImpl ?? fetch)(`${opts.gatewayBaseUrl}/v1/skills/tools`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      if (response.status === 304) return;
      if (!response.ok) {
        opts.logger.warn?.(`skill-proxy: tool catalog answered ${response.status}`);
        return;
      }

      const fresh: unknown = await response.json();
      if (!valid(fresh)) return;

      catalog = { digest: fresh.digest, tools: usable(fresh.tools) };

      mkdirSync(dirname(opts.cacheFile), { recursive: true });
      const tmp = `${opts.cacheFile}.tmp.${process.pid}`;
      writeFileSync(tmp, JSON.stringify(catalog), "utf8");
      renameSync(tmp, opts.cacheFile);

      opts.logger.info(
        `skill-proxy: typed tools ${catalog.tools.map((t) => t.tool).join(", ") || "none"}`,
      );
    } catch (err) {
      opts.logger.warn?.(`skill-proxy: tool catalog unreachable: ${String(err)}`);
    }
  };

  return {
    current: () => catalog.tools,
    refresh,
    start: () => {
      void refresh();
      setInterval(() => void refresh(), REFRESH_MS).unref?.();
    },
  };
}
