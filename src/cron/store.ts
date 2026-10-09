import JSON5 from "json5";
import fs from "node:fs";
import path from "node:path";
import type { CronStoreFile } from "./types.js";
import { expandHomePrefix } from "../infra/home-dir.js";
import { CONFIG_DIR } from "../utils.js";

export const DEFAULT_CRON_DIR = path.join(CONFIG_DIR, "cron");
export const DEFAULT_CRON_STORE_PATH = path.join(DEFAULT_CRON_DIR, "jobs.json");

export function resolveCronStorePath(storePath?: string) {
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw));
    }
    return path.resolve(raw);
  }
  return DEFAULT_CRON_STORE_PATH;
}

function parseCronStore(raw: string): CronStoreFile {
  const parsed: unknown = JSON5.parse(raw);
  const parsedRecord =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const jobs = Array.isArray(parsedRecord.jobs) ? (parsedRecord.jobs as never[]) : [];
  return {
    version: 1,
    jobs: jobs.filter(Boolean) as never as CronStoreFile["jobs"],
  };
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, "utf-8");
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Loads the cron store. A broken store must never switch cron off (actiq CLT-061):
 * on 2026-10-09 an instance had an empty jobs.json since a snapshot taken mid-write,
 * cron "failed to start" on every boot for seven weeks, and every reminder the user
 * asked for silently never fired.
 *
 * - missing or empty (whitespace-only) file: an empty store;
 * - unparsable file: the last good copy (`.bak`, written after every save);
 * - both unusable: the broken file is moved aside (kept for inspection), cron starts
 *   with an empty store, and the error is logged loudly.
 */
export async function loadCronStore(
  storePath: string,
  log: (message: string) => void = (message) => console.error(message),
): Promise<CronStoreFile> {
  const raw = await readIfExists(storePath);
  if (raw === null || raw.trim() === "") {
    if (raw !== null) {
      log(`cron: store at ${storePath} is empty — starting with no jobs`);
    }
    return { version: 1, jobs: [] };
  }

  try {
    return parseCronStore(raw);
  } catch (err) {
    log(`cron: failed to parse store at ${storePath}: ${String(err)} — trying ${storePath}.bak`);
  }

  const backup = await readIfExists(`${storePath}.bak`);
  if (backup !== null && backup.trim() !== "") {
    try {
      const restored = parseCronStore(backup);
      log(`cron: restored ${restored.jobs.length} job(s) from ${storePath}.bak`);
      return restored;
    } catch (err) {
      log(`cron: backup ${storePath}.bak is unusable too: ${String(err)}`);
    }
  }

  const aside = `${storePath}.corrupt-${Date.now()}`;
  try {
    await fs.promises.rename(storePath, aside);
    log(`cron: CORRUPT STORE moved to ${aside}; starting with no jobs`);
  } catch (err) {
    log(
      `cron: CORRUPT STORE at ${storePath} could not be moved aside: ${String(err)}; starting with no jobs`,
    );
  }
  return { version: 1, jobs: [] };
}

export async function saveCronStore(storePath: string, store: CronStoreFile) {
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const json = JSON.stringify(store, null, 2);
  await fs.promises.writeFile(tmp, json, "utf-8");
  // fsync before the rename: a machine imaged or powered off right after a save must
  // not come back with an empty jobs.json (actiq CLT-061). Best-effort — a filesystem
  // without fsync still gets the save.
  try {
    const handle = await fs.promises.open(tmp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // best-effort
  }
  await fs.promises.rename(tmp, storePath);
  try {
    await fs.promises.copyFile(storePath, `${storePath}.bak`);
  } catch {
    // best-effort
  }
}
