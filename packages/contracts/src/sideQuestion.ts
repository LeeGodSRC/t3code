import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SideQuestionInput = Schema.Struct({
  threadId: ThreadId,
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
});
export type SideQuestionInput = typeof SideQuestionInput.Type;

export const SideQuestionResult = Schema.Struct({
  answer: Schema.String,
  contextTruncated: Schema.Boolean,
});
export type SideQuestionResult = typeof SideQuestionResult.Type;

export class SideQuestionError extends Schema.TaggedError<SideQuestionError>()(
  "SideQuestionError",
  {
    reason: Schema.Literals(["unsupported-provider", "unavailable", "generation-failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported-provider":
        return "Side questions are not supported by this provider yet. Use a Claude Code thread.";
      case "unavailable":
        return "This conversation is no longer available.";
      case "generation-failed":
        return "Could not answer the side question. Please try again.";
    }
  }
}

/** An empty question opens the side-question composer. */
export function parseSideQuestion(text: string): string | null {
  const match = /^\/btw(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? (match[1]?.trim() ?? "") : null;
}
