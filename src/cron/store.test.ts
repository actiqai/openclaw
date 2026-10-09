import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCronStore, resolveCronStorePath, saveCronStore } from "./store.js";

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-store-"));
  return {
    dir,
    storePath: path.join(dir, "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

describe("resolveCronStorePath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses OPENCLAW_HOME for tilde expansion", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    const result = resolveCronStorePath("~/cron/jobs.json");
    expect(result).toBe(path.resolve("/srv/openclaw-home", "cron", "jobs.json"));
  });
});

describe("cron store", () => {
  it("returns empty store when file does not exist", async () => {
    const store = await makeStorePath();
    const loaded = await loadCronStore(store.storePath);
    expect(loaded).toEqual({ version: 1, jobs: [] });
    await store.cleanup();
  });

  // actiq CLT-061: a broken store must never switch cron off.
  it("treats an empty file as an empty store", async () => {
    const store = await makeStorePath();
    await fs.writeFile(store.storePath, "", "utf-8");
    const logged: string[] = [];
    await expect(loadCronStore(store.storePath, (m) => logged.push(m))).resolves.toEqual({
      version: 1,
      jobs: [],
    });
    expect(logged.join("\n")).toMatch(/empty/);
    await store.cleanup();
  });

  it("restores jobs from the backup when the store is corrupt", async () => {
    const store = await makeStorePath();
    await fs.writeFile(store.storePath, "{ not json", "utf-8");
    await fs.writeFile(
      `${store.storePath}.bak`,
      JSON.stringify({ version: 1, jobs: [{ id: "remind-1" }] }),
      "utf-8",
    );
    const loaded = await loadCronStore(store.storePath, () => {});
    expect(loaded.jobs).toEqual([{ id: "remind-1" }]);
    await store.cleanup();
  });

  it("moves an unusable store aside and starts empty instead of throwing", async () => {
    const store = await makeStorePath();
    await fs.writeFile(store.storePath, "{ not json", "utf-8");
    await fs.writeFile(`${store.storePath}.bak`, "also broken {", "utf-8");
    const logged: string[] = [];
    await expect(loadCronStore(store.storePath, (m) => logged.push(m))).resolves.toEqual({
      version: 1,
      jobs: [],
    });
    const files = await fs.readdir(store.dir);
    expect(files.some((f) => f.startsWith("jobs.json.corrupt-"))).toBe(true);
    expect(logged.join("\n")).toMatch(/CORRUPT STORE/);
    await store.cleanup();
  });

  it("saves through fsync and keeps a backup copy", async () => {
    const store = await makeStorePath();
    await saveCronStore(store.storePath, { version: 1, jobs: [] });
    const saved = JSON.parse(await fs.readFile(store.storePath, "utf-8"));
    const backup = JSON.parse(await fs.readFile(`${store.storePath}.bak`, "utf-8"));
    expect(saved).toEqual({ version: 1, jobs: [] });
    expect(backup).toEqual(saved);
    await store.cleanup();
  });
});
