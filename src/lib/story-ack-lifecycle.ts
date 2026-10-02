/** UI failures cannot change a Story write whose acknowledgement was verified. */
export function runAcknowledgedStoryEffects(
  callbacks: {
    onSuccess: () => void | Promise<void>;
    onClose: () => void | Promise<void>;
  },
  report: (phase: "refresh" | "close", error: unknown) => void,
): Promise<void> {
  const safelyReport = (phase: "refresh" | "close", error: unknown) => {
    try {
      report(phase, error);
    } catch {
      /* Diagnostic failure cannot permit another write. */
    }
  };
  const invoke = (
    phase: "refresh" | "close",
    callback: () => void | Promise<void>,
  ) => {
    try {
      return Promise.resolve(callback()).catch((error) =>
        safelyReport(phase, error),
      );
    } catch (error) {
      safelyReport(phase, error);
      return Promise.resolve();
    }
  };
  // Closing does not await a feed refresh, and each callback runs exactly once.
  return Promise.all([
    invoke("refresh", callbacks.onSuccess),
    invoke("close", callbacks.onClose),
  ]).then(() => undefined);
}
