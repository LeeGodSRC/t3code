import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId, SideQuestionResult } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { Modal, ScrollView, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";

export function SideQuestionSheet(props: {
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
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <View className="flex-1 bg-background px-5 pb-8 pt-12">
        <View className="flex-row items-center justify-between pb-4">
          <Text className="text-lg font-t3-semibold text-foreground">Side question</Text>
          <MaterialButton label="Close" tone="text" onPress={props.onClose} />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled">
          <View className="gap-4">
            <Text className="text-foreground-muted">
              Uses the conversation’s text. Your main task continues; this question and answer stay
              out of its history.
            </Text>
            {result ? (
              <>
                <Text className="text-foreground-muted">{question}</Text>
                <Text selectable className="text-foreground">
                  {result.answer}
                </Text>
                {result.contextTruncated && (
                  <Text className="text-foreground-muted">
                    Only the most recent conversation text was included.
                  </Text>
                )}
              </>
            ) : (
              <>
                <TextInput
                  accessibilityLabel="Side question"
                  placeholder="Ask about this conversation…"
                  multiline
                  value={question}
                  maxLength={8000}
                  editable={!pending}
                  onChangeText={setQuestion}
                  className="min-h-24 rounded-xl border border-border p-3 text-foreground"
                />
                {error && (
                  <Text accessibilityRole="alert" className="text-danger">
                    {error}
                  </Text>
                )}
                {!allowed && (
                  <Text>You don’t have permission to ask questions in this environment.</Text>
                )}
                <MaterialButton
                  label={pending ? "Answering…" : error ? "Try again" : "Ask"}
                  disabled={pending || !allowed || !question.trim()}
                  onPress={() => void submit()}
                />
              </>
            )}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
