import { useCallback, useState } from "react";
import { toast } from "./toast";

/**
 * The one place an operation's lifecycle lives: idle → busy → idle, with the
 * outcome always reported.
 *
 * Every write in the wallet runs through this, so send, deposit, withdraw,
 * merge and recover behave identically — same busy semantics, same success
 * wording, same error surface. There is no dead state: a rejected promise
 * always produces an error toast and returns the flow to idle.
 *
 * Note what this hook deliberately does NOT do: it carries no phase list.
 * SombraClient exposes a progress channel for recovery only, so captioning the
 * intermediate steps of a send would mean inventing text the client cannot
 * back — and that text would desync the moment the live client lands. Progress
 * narration belongs to the flows that actually report progress.
 */
export interface OperationFlow<T> {
  busy: boolean;
  error: string | null;
  result: T | null;
  run: (
    op: () => Promise<T>,
    messages: {
      /** Toast title on success. Written in the past tense of the CTA. */
      success: string;
      /** Optional detail line — a hash, a count, an amount. */
      describe?: (result: T) => string | undefined;
      /** Toast title on failure. The thrown message becomes the detail. */
      failure: string;
    },
  ) => Promise<T | null>;
  reset: () => void;
}

export function useOperationFlow<T>(): OperationFlow<T> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<T | null>(null);

  const run = useCallback<OperationFlow<T>["run"]>(async (op, messages) => {
    setBusy(true);
    setError(null);
    try {
      const value = await op();
      setResult(value);
      toast.success(messages.success, messages.describe?.(value));
      return value;
    } catch (err) {
      const detail =
        err instanceof Error ? err.message : "The operation did not complete.";
      setError(detail);
      toast.error(messages.failure, detail);
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const reset = useCallback(() => {
    setError(null);
    setResult(null);
  }, []);

  return { busy, error, result, run, reset };
}
