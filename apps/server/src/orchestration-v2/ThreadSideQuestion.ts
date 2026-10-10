import {
  SideQuestionError,
  type SideQuestionInput,
  type SideQuestionResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const encodeContext = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String }))),
);

export class ThreadSideQuestion extends Context.Service<
  ThreadSideQuestion,
  {
    readonly ask: (
      input: SideQuestionInput,
    ) => Effect.Effect<SideQuestionResult, SideQuestionError>;
  }
>()("t3/orchestration-v2/ThreadSideQuestion") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  const ask = Effect.fn("ThreadSideQuestion.ask")(function* (input: SideQuestionInput) {
    const projection = yield* threads
      .getThreadRecords(input.threadId, ["messages"], {
        messageRoles: ["user", "assistant"],
      })
      .pipe(Effect.mapError((cause) => new SideQuestionError({ reason: "unavailable", cause })));
    const project = yield* projects
      .get(projection.thread.projectId)
      .pipe(Effect.mapError((cause) => new SideQuestionError({ reason: "unavailable", cause })));
    if (Option.isNone(project)) return yield* new SideQuestionError({ reason: "unavailable" });
    const modelSelection = projection.thread.modelSelection;
    const provider = yield* providers.getInstance(modelSelection.instanceId);
    const generate = provider?.textGeneration.generateSideQuestion;
    if (!generate) return yield* new SideQuestionError({ reason: "unsupported-provider" });

    // Bound prompt size; take recent messages without materializing another full transcript string.
    let remaining = 80_000;
    let contextTruncated = false;
    const messages: Array<{ role: string; text: string }> = [];
    for (let index = projection.messages.length - 1; index >= 0; index--) {
      const message = projection.messages[index]!;
      if (!message.text) continue;
      if (remaining === 0) {
        contextTruncated = true;
        break;
      }
      const text = message.text.slice(-remaining);
      if (text.length < message.text.length) contextTruncated = true;
      messages.push({ role: message.role, text });
      remaining -= text.length;
    }
    const result = yield* generate({
      cwd: projection.thread.worktreePath ?? project.value.workspaceRoot,
      modelSelection,
      question: input.question,
      context: encodeContext(messages.toReversed()),
    }).pipe(
      Effect.mapError((cause) => new SideQuestionError({ reason: "generation-failed", cause })),
    );
    return { answer: result.answer, contextTruncated };
  });
  return ThreadSideQuestion.of({ ask });
});

export const layer = Layer.effect(ThreadSideQuestion, make);
