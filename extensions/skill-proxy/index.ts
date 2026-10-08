import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { emitSkillToolCall } from "openclaw/plugin-sdk";
import { createToolCatalog, typedTool } from "./typed-tools.js";

const DEFAULT_GATEWAY_BASE_URL = "http://10.0.1.40:8082";

// Рядом с данными skill-state: этот каталог уезжает в бэкап (том `openclaw-state`).
const DEFAULT_STATE_DIR = "/home/openclaw/.openclaw/actiq";

// Имя поставщика становится именем файла — пускаем только то, что не выведет
// из каталога.
const PROVIDER = /^[a-z0-9-]{1,32}$/;

/**
 * Подключения человека к внешним сервисам (`CLT-059`, план
 * `actiq/.ai/plans/connections.md`).
 *
 * Здесь лежат не токены, а блобы, запечатанные ключом гейтвея и привязанные к
 * этому инстансу: распечатать их может только гейтвей. Расширение прикладывает
 * их к каждому вызову скилла и сохраняет то, что гейтвей вернёт (новый блоб
 * после входа или обновления токена; пустая строка — стереть). Модель блобов
 * не видит: из ответа они вырезаются до того, как он станет выводом тула.
 */
export function readConnections(dir: string): Record<string, string> {
  if (!existsSync(dir)) {
    return {};
  }

  const out: Record<string, string> = {};

  for (const file of readdirSync(dir)) {
    const provider = file.endsWith(".blob") ? file.slice(0, -".blob".length) : "";

    if (PROVIDER.test(provider)) {
      const blob = readFileSync(join(dir, file), "utf8").trim();

      if (blob) {
        out[provider] = blob;
      }
    }
  }

  return out;
}

export function saveConnections(dir: string, updates: unknown): void {
  if (!updates || typeof updates !== "object") {
    return;
  }

  for (const [provider, blob] of Object.entries(updates as Record<string, unknown>)) {
    if (!PROVIDER.test(provider) || typeof blob !== "string") {
      continue;
    }

    const path = join(dir, `${provider}.blob`);

    if (blob === "") {
      rmSync(path, { force: true });
      continue;
    }

    // Атомарно: оборванная запись оставила бы обрубок, и человеку пришлось бы
    // подключаться заново.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, blob, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  }
}

const skillProxyPlugin = {
  id: "skill-proxy",
  name: "Skill Proxy",
  description: "Executes platform skills hosted on actiq-gateway",

  register(api: OpenClawPluginApi) {
    const gatewayBaseUrl = (
      (api.pluginConfig?.gatewayBaseUrl as string) || DEFAULT_GATEWAY_BASE_URL
    ).replace(/\/+$/, "");
    // Токен инстанса — то, по чему гейтвей узнаёт, чей это вызов. Скиллам с
    // подключением без него не открыть блоб; остальным он не мешает.
    const instanceToken = (api.pluginConfig?.instanceToken as string) || "";
    const connectionsDir = join(
      (api.pluginConfig?.stateDir as string) || DEFAULT_STATE_DIR,
      "connections",
    );
    const stateDir = (api.pluginConfig?.stateDir as string) || DEFAULT_STATE_DIR;

    /** Один вызов скилла на гейтвее — общий для `call_skill` и типизированных инструментов. */
    const callGateway = async (skill: string, action: string, params: Record<string, unknown>) => {
      // Единая точка входа: адрес один на всю платформу, скилл едет в теле.
      const url = `${gatewayBaseUrl}/v1/skill`;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      if (instanceToken) {
        headers["X-Instance-Token"] = instanceToken;
      }

      let connections: Record<string, string> = {};
      try {
        connections = readConnections(connectionsDir);
      } catch (err) {
        api.logger.warn?.(`skill-proxy: cannot read connections: ${String(err)}`);
      }

      const body: Record<string, unknown> = { skill, action, params };
      if (Object.keys(connections).length > 0) {
        body.connections = connections;
      }

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "error", message: `Gateway unreachable: ${msg}` }),
            },
          ],
          // Поле обязательно в контракте тула агента; структуры сверх JSON у нас нет.
          details: null,
        };
      }

      const data = await response.json();

      if (data && typeof data === "object" && "connections" in data) {
        try {
          saveConnections(connectionsDir, (data as Record<string, unknown>).connections);
        } catch (err) {
          api.logger.warn?.(`skill-proxy: cannot save connections: ${String(err)}`);
        }
        // Блоб модели ни к чему: в истории сессии он только занимал бы место.
        delete (data as Record<string, unknown>).connections;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(data, null, 2),
          },
        ],
        details: null,
      };
    };

    // Типизированные инструменты (`CLT-060`): описания приходят с гейтвея, лежат
    // копией рядом с данными — после перезапуска без сети инструменты остаются.
    const tools = createToolCatalog({
      gatewayBaseUrl,
      instanceToken,
      cacheFile: join(stateDir, "skill-tools.json"),
      logger: api.logger,
    });
    tools.start();

    const today = new Date().toISOString().slice(0, 10);

    const callSkillTool = {
      label: "Call Platform Skill",
      name: "call_skill",
      description:
        `Today is ${today}. Resolve relative dates the user gives («на выходных» → the nearest ` +
        "upcoming Saturday; «завтра», «в июле» …) into a concrete YYYY-MM-DD before calling — " +
        "never drop the timeframe the user asked for.\n" +
        "Executes a platform skill on the actiq-gateway and returns its real results. " +
        "The available skills, their actions and their parameters are described by the skills " +
        "themselves — follow the instructions of the skill you are using. " +
        "NEVER invent results: report only what the skill returns, and always include any links " +
        "from the response. Do not interrogate the user — infer what you can from context and call.",
      parameters: Type.Object({
        skill: Type.String({
          description: 'Skill name, e.g. "travelpayouts"',
        }),
        action: Type.String({
          description: 'Action, e.g. "cheapest_from" (anywhere) or "search_flights" (known route)',
        }),
        params: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description: "Action parameters as key-value pairs",
          }),
        ),
      }),
      execute: async (_toolCallId: string, args: Record<string, unknown>) =>
        callGateway(
          args.skill as string,
          args.action as string,
          (args.params as Record<string, unknown>) ?? {},
        ),
    };

    // Фабрика ради сессии: по вызову `skill-state` считает шаг скилла, который
    // уедет к роутеру заголовком вместе с ответом (CLT-056). Типизированный вызов
    // сообщается так же, как `call_skill`: для шага важен скилл, а не инструмент.
    api.registerTool((ctx: { sessionKey?: string }) => {
      const generic = {
        ...callSkillTool,
        execute: async (toolCallId: string, args: Record<string, unknown>) => {
          const result = await callSkillTool.execute(toolCallId, args);
          emitSkillToolCall(ctx.sessionKey, { tool: "call_skill", params: args, result });
          return result;
        },
      };

      const typed = tools.current().map((spec) => {
        const tool = typedTool(spec, callGateway);

        return {
          ...tool,
          execute: async (toolCallId: string, args: Record<string, unknown>) => {
            const result = await tool.execute(toolCallId, args);
            const { action, ...params } = args;
            emitSkillToolCall(ctx.sessionKey, {
              tool: "call_skill",
              params: { skill: spec.skill, action, params },
              result,
            });
            return result;
          },
        };
      });

      return [generic, ...typed];
    });

    api.logger.info(`Skill proxy registered, gateway: ${gatewayBaseUrl}`);
  },
};

export default skillProxyPlugin;
