type VisibilityListener = () => void;
type BrowserIntervalId = ReturnType<typeof globalThis.setInterval>;

type VisibilityPollingEnvironment<IntervalId> = {
  getHidden: () => boolean;
  addVisibilityListener: (listener: VisibilityListener) => void;
  removeVisibilityListener: (listener: VisibilityListener) => void;
  setInterval: (callback: () => void, intervalMs: number) => IntervalId;
  clearInterval: (intervalId: IntervalId) => void;
};

function defaultEnvironment(): VisibilityPollingEnvironment<BrowserIntervalId> {
  return {
    getHidden: () => document.hidden,
    addVisibilityListener: (listener) => {
      document.addEventListener("visibilitychange", listener);
    },
    removeVisibilityListener: (listener) => {
      document.removeEventListener("visibilitychange", listener);
    },
    setInterval: (callback, intervalMs) =>
      globalThis.setInterval(callback, intervalMs),
    clearInterval: (intervalId) => globalThis.clearInterval(intervalId),
  };
}

/**
 * Poll while the document is visible and pause the timer while it is hidden.
 * The initial refresh always runs, including when mounted in a hidden tab.
 */
export function startVisibilityPolling<IntervalId = BrowserIntervalId>(
  refresh: () => unknown,
  intervalMs = 30000,
  environment: VisibilityPollingEnvironment<IntervalId> = defaultEnvironment() as unknown as VisibilityPollingEnvironment<IntervalId>,
): () => void {
  let intervalId: IntervalId | null = null;

  const stop = () => {
    if (intervalId === null) return;
    environment.clearInterval(intervalId);
    intervalId = null;
  };

  const start = () => {
    if (intervalId !== null || environment.getHidden()) return;
    intervalId = environment.setInterval(() => {
      void refresh();
    }, intervalMs);
  };

  const handleVisibility = () => {
    if (environment.getHidden()) {
      stop();
      return;
    }

    void refresh();
    start();
  };

  void refresh();
  start();
  environment.addVisibilityListener(handleVisibility);

  return () => {
    stop();
    environment.removeVisibilityListener(handleVisibility);
  };
}
