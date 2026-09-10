import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../workspace-run.js", () => ({
  resolveRunWorkspaceDir: vi.fn((params: { workspaceDir: string }) => ({
    workspaceDir: params.workspaceDir,
    usedFallback: false,
    fallbackReason: undefined,
    agentId: "main",
  })),
  redactRunIdentifier: vi.fn((value?: string) => value ?? ""),
}));

import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { runEmbeddedAttempt } from "./run/attempt.js";

const mockedRunEmbeddedAttempt = vi.mocked(runEmbeddedAttempt);

const baseParams = {
  sessionId: "test-session",
  sessionKey: "agent:main:cron:job-1:run:test-session",
  sessionFile: "/tmp/session.json",
  workspaceDir: "/tmp/workspace",
  prompt: "hello",
  timeoutMs: 30000,
  runId: "run-1",
};

describe("runEmbeddedPiAgent message tool flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Cron announce runs set these so the agent cannot send messages itself; the summary
  // is delivered by the announce flow. Dropping them here silently re-armed the message
  // tool with no target, which surfaced in chat as "Action send requires a target.".
  it("forwards disableMessageTool and requireExplicitMessageTarget to the attempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...baseParams,
      requireExplicitMessageTarget: true,
      disableMessageTool: true,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        disableMessageTool: true,
        requireExplicitMessageTarget: true,
      }),
    );
  });

  it("leaves both flags undefined when the caller does not set them", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({ ...baseParams });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        disableMessageTool: undefined,
        requireExplicitMessageTarget: undefined,
      }),
    );
  });
});
