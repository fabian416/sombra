/**
 * A three-function toast bus.
 *
 * Deliberately not a context provider: the wallet's provider tree is owned by
 * another workstream right now, and an operation should be able to report its
 * outcome from anywhere without threading a hook through the call site.
 */
export type ToastTone = "success" | "error";

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

type Listener = (toasts: Toast[]) => void;

const listeners = new Set<Listener>();
let toasts: Toast[] = [];
let seq = 0;

/** How long a toast stays up. Errors linger — they carry something to act on. */
const TTL: Record<ToastTone, number> = { success: 4_500, error: 8_000 };

function emit() {
  for (const listener of listeners) listener(toasts);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => listeners.delete(listener);
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function pushToast(
  tone: ToastTone,
  title: string,
  description?: string,
): number {
  const id = ++seq;
  toasts = [...toasts, { id, tone, title, description }];
  emit();
  setTimeout(() => dismissToast(id), TTL[tone]);
  return id;
}

export const toast = {
  success: (title: string, description?: string) =>
    pushToast("success", title, description),
  error: (title: string, description?: string) =>
    pushToast("error", title, description),
};
