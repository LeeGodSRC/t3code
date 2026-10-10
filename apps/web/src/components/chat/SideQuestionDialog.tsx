import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId, SideQuestionResult } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";

export function SideQuestionDialog(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  initialQuestion: string;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState(props.initialQuestion);
  const [pending, setPending] = useState(Boolean(props.initialQuestion));
  const [result, setResult] = useState<SideQuestionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const started = useRef(false);
  const allowed = useAtomValue(
    orchestrationEnvironment.sideQuestion.permissionAtom(props.environmentId),
  );
  const ask = useAtomCommand(orchestrationEnvironment.sideQuestion, { reportFailure: false });
  const runQuestion = useCallback(async () => {
    if (busy.current || !question.trim() || !allowed) return;
    busy.current = true;
    const response = await ask({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, question: question.trim() },
    });
    busy.current = false;
    setPending(false);
    if (response._tag === "Success") setResult(response.value);
    else {
      const failure = squashAtomCommandFailure(response);
      setError(failure instanceof Error ? failure.message : "Could not answer. Please try again.");
    }
  }, [allowed, ask, props.environmentId, props.threadId, question]);
  useEffect(() => {
    if (started.current || !allowed) return;
    started.current = true;
    // oxlint-disable-next-line react/set-state-in-effect -- State changes only after the RPC promise resolves.
    if (props.initialQuestion) void runQuestion();
  }, [allowed, props.initialQuestion, runQuestion]);

  const submit = () => {
    if (busy.current || !allowed || !question.trim()) return;
    setPending(true);
    setError(null);
    void runQuestion();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Side question</DialogTitle>
          <DialogDescription>
            Uses the conversation’s text. Your main task continues; this question and answer stay
            out of its history.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {result ? (
            <>
              <p className="text-sm text-muted-foreground">{question}</p>
              <ChatMarkdown
                text={result.answer}
                cwd={undefined}
                environmentId={props.environmentId}
              />
              {result.contextTruncated && (
                <p className="text-xs text-muted-foreground">
                  Only the most recent conversation text was included.
                </p>
              )}
            </>
          ) : (
            <>
              <Textarea
                aria-label="Side question"
                placeholder="Ask about this conversation…"
                value={question}
                maxLength={8000}
                disabled={pending}
                onChange={(event) => setQuestion(event.target.value)}
              />
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {!allowed && (
                <p role="alert">You don’t have permission to ask questions in this environment.</p>
              )}
              <Button
                type="button"
                disabled={pending || !allowed || !question.trim()}
                onClick={() => void submit()}
              >
                {pending ? "Answering…" : error ? "Try again" : "Ask"}
              </Button>
              {pending && (
                <p role="status" className="text-xs text-muted-foreground">
                  You can close this window at any time.
                </p>
              )}
            </>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
