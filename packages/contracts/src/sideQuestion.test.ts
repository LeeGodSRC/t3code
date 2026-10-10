import { describe, it, expect } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { parseSideQuestion, SideQuestionInput } from "./sideQuestion.ts";

describe("side questions", () => {
  it("recognizes only a leading complete /btw command", () => {
    expect(parseSideQuestion("/btw")).toBe("");
    expect(parseSideQuestion(" /BTW why?\nAnd when? ")).toBe("why?\nAnd when?");
    expect(parseSideQuestion("Explain /btw please")).toBeNull();
    expect(parseSideQuestion("/btwhatever")).toBeNull();
    expect(parseSideQuestion("/btw/path")).toBeNull();
  });
  it("rejects empty and oversized wire questions", () => {
    const decode = Schema.decodeUnknownSync(SideQuestionInput);
    expect(() => decode({ threadId: "thread", question: " " })).toThrow();
    expect(() => decode({ threadId: "thread", question: "x".repeat(8001) })).toThrow();
  });
});
