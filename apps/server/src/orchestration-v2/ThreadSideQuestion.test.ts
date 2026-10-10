import { describe, it, expect, vi } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TextGenerationError,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import type { ProviderAdapterV2Shape } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as SideQuestions from "./ThreadSideQuestion.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";

const projectId = ProjectId.make("project:btw");
const modelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-sonnet-4-6",
};
const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Side questions must never open the main provider session"),
} as ProviderAdapterV2Shape;

function harness(generateSideQuestion?: ProviderTextGeneration["generateSideQuestion"]) {
  const databaseLayer = SqlitePersistence.layerMemory;
  const orchestration = ProviderReplayHarness.layerWithRegistry(
    { name: "btw" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer, runEffectWorker: false },
  );
  const threads = ThreadManagement.layer.pipe(Layer.provide(orchestration));
  const provider = { textGeneration: { generateSideQuestion } } as ProviderInstance;
  const questions = SideQuestions.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        threads,
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: () => Effect.succeed(provider),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeed(
              Option.some({
                projectId,
                title: "Test",
                workspaceRoot: "/repo",
                defaultModelSelection: modelSelection,
                defaultThreadEnvMode: null,
                autoPull: false,
                faviconPath: null,
                projectIcon: null,
                scripts: [],
                createdAt: "2026-10-10T00:00:00.000Z",
                updatedAt: "2026-10-10T00:00:00.000Z",
                deletedAt: null,
              }),
            ),
        }),
      ),
    ),
  );
  return Layer.mergeAll(threads, questions);
}

function createThread(input: { readonly command: string; readonly thread: string }) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make(input.thread);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(input.command),
      threadId,
      projectId,
      title: "Seed title",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });
}

function dispatchUserMessage(input: {
  readonly command: string;
  readonly threadId: ThreadId;
  readonly text: string;
}) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(input.command),
      threadId: input.threadId,
      messageId: MessageId.make(`${input.command}:message`),
      text: input.text,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
  });
}

describe("side questions", () => {
  it.effect("answers from the transcript without changing messages or main-thread state", () => {
    const generate = vi.fn(() => Effect.succeed({ answer: "The marker is BLUE." }));
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const questions = yield* SideQuestions.ThreadSideQuestion;
      const threadId = yield* createThread({ command: "create", thread: "btw-thread" });
      yield* dispatchUserMessage({ command: "message", threadId, text: "Remember BLUE" });
      const before = yield* threads.getThreadRecords(threadId, ["messages", "runs"]);
      expect(yield* questions.ask({ threadId, question: "What is the marker?" })).toEqual({
        answer: "The marker is BLUE.",
        contextTruncated: false,
      });
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.stringContaining("Remember BLUE"),
          modelSelection,
        }),
      );
      expect(yield* threads.getThreadRecords(threadId, ["messages", "runs"])).toEqual(before);
    }).pipe(Effect.provide(harness(generate)));
  });
  it.effect("does not hold up main-thread commands while the answer is pending", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const questions = yield* SideQuestions.ThreadSideQuestion;
        const threadId = yield* createThread({ command: "create", thread: "btw-thread" });
        const answer = yield* questions
          .ask({ threadId, question: "What now?" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("rename"),
          threadId,
          title: "Still working",
        });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(answer);
      }).pipe(
        Effect.provide(
          harness(() =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ answer: "Done" }),
            ),
          ),
        ),
      );
    }),
  );
  it.effect("bounds long context and retains the latest question", () => {
    const generate = vi.fn(() => Effect.succeed({ answer: "Latest context" }));
    return Effect.gen(function* () {
      const threadId = yield* createThread({ command: "create", thread: "btw-thread" });
      yield* dispatchUserMessage({ command: "old", threadId, text: "x".repeat(85_000) });
      yield* dispatchUserMessage({ command: "latest", threadId, text: "Newest marker" });
      const questions = yield* SideQuestions.ThreadSideQuestion;
      const result = yield* questions.ask({ threadId, question: "What changed?" });
      expect(result.contextTruncated).toBe(true);
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({ context: expect.stringContaining("Newest marker") }),
      );
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({ context: expect.not.stringContaining("x".repeat(80_000)) }),
      );
    }).pipe(Effect.provide(harness(generate)));
  });
  it.effect("explicitly rejects providers without tool-free question support", () =>
    Effect.gen(function* () {
      const threadId = yield* createThread({ command: "create", thread: "btw-thread" });
      const questions = yield* SideQuestions.ThreadSideQuestion;
      expect((yield* questions.ask({ threadId, question: "Hi" }).pipe(Effect.flip)).reason).toBe(
        "unsupported-provider",
      );
    }).pipe(Effect.provide(harness())),
  );
  it.effect("reports generation failures without inserting a chat message", () =>
    Effect.gen(function* () {
      const threadId = yield* createThread({ command: "create", thread: "btw-thread" });
      const questions = yield* SideQuestions.ThreadSideQuestion;
      const threads = yield* ThreadManagement.ThreadManagementService;
      expect((yield* questions.ask({ threadId, question: "Hi" }).pipe(Effect.flip)).reason).toBe(
        "generation-failed",
      );
      expect((yield* threads.getThreadRecords(threadId, ["messages"])).messages).toHaveLength(0);
    }).pipe(
      Effect.provide(
        harness(() =>
          Effect.fail(
            new TextGenerationError({ operation: "generateSideQuestion", detail: "test" }),
          ),
        ),
      ),
    ),
  );
});
