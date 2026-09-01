import { assertEquals } from "#test/assert";
import { test } from "bun:test";
import { startVisibilityPolling } from "./visibility-polling.ts";

function createHarness(initiallyHidden = false) {
  let hidden = initiallyHidden;
  let listener: (() => void) | null = null;
  let nextTimerId = 1;
  let addListenerCalls = 0;
  let removeListenerCalls = 0;
  let setIntervalCalls = 0;
  let clearIntervalCalls = 0;
  const timers = new Map<number, () => void>();

  const environment = {
    getHidden: () => hidden,
    addVisibilityListener: (nextListener: () => void) => {
      addListenerCalls += 1;
      listener = nextListener;
    },
    removeVisibilityListener: (nextListener: () => void) => {
      removeListenerCalls += 1;
      if (listener === nextListener) listener = null;
    },
    setInterval: (callback: () => void, _intervalMs: number) => {
      setIntervalCalls += 1;
      const timerId = nextTimerId++;
      timers.set(timerId, callback);
      return timerId;
    },
    clearInterval: (timerId: number) => {
      clearIntervalCalls += 1;
      timers.delete(timerId);
    },
  };

  return {
    environment,
    timers,
    get addListenerCalls() {
      return addListenerCalls;
    },
    get removeListenerCalls() {
      return removeListenerCalls;
    },
    get setIntervalCalls() {
      return setIntervalCalls;
    },
    get clearIntervalCalls() {
      return clearIntervalCalls;
    },
    setHidden(nextHidden: boolean) {
      hidden = nextHidden;
      listener?.();
    },
    fireNextTimer() {
      const timer = timers.values().next().value as (() => void) | undefined;
      timer?.();
    },
  };
}

test("runs the initial refresh and a visible interval", () => {
  const harness = createHarness();
  let refreshes = 0;
  const cleanup = startVisibilityPolling(
    () => {
      refreshes += 1;
    },
    5000,
    harness.environment,
  );

  assertEquals(refreshes, 1);
  assertEquals(harness.timers.size, 1);
  harness.fireNextTimer();
  assertEquals(refreshes, 2);

  cleanup();
});

test("refreshes once on a hidden mount without starting a timer", () => {
  const harness = createHarness(true);
  let refreshes = 0;
  const cleanup = startVisibilityPolling(
    () => {
      refreshes += 1;
    },
    5000,
    harness.environment,
  );

  assertEquals(refreshes, 1);
  assertEquals(harness.timers.size, 0);

  cleanup();
});

test("refreshes immediately and resumes polling when becoming visible", () => {
  const harness = createHarness(true);
  let refreshes = 0;
  const cleanup = startVisibilityPolling(
    () => {
      refreshes += 1;
    },
    5000,
    harness.environment,
  );

  harness.setHidden(false);

  assertEquals(refreshes, 2);
  assertEquals(harness.timers.size, 1);
  assertEquals(harness.setIntervalCalls, 1);

  cleanup();
});

test("does not start duplicate intervals on repeated visible events", () => {
  const harness = createHarness();
  let refreshes = 0;
  const cleanup = startVisibilityPolling(
    () => {
      refreshes += 1;
    },
    5000,
    harness.environment,
  );

  harness.setHidden(false);
  harness.setHidden(false);

  assertEquals(refreshes, 3);
  assertEquals(harness.timers.size, 1);
  assertEquals(harness.setIntervalCalls, 1);

  cleanup();
});

test("stops polling when becoming hidden", () => {
  const harness = createHarness();
  const cleanup = startVisibilityPolling(() => {}, 5000, harness.environment);

  harness.setHidden(true);

  assertEquals(harness.timers.size, 0);
  assertEquals(harness.clearIntervalCalls, 1);

  cleanup();
});

test("cleanup removes the listener and active timer", () => {
  const harness = createHarness();
  let refreshes = 0;
  const cleanup = startVisibilityPolling(
    () => {
      refreshes += 1;
    },
    5000,
    harness.environment,
  );

  cleanup();
  harness.setHidden(true);

  assertEquals(harness.timers.size, 0);
  assertEquals(harness.clearIntervalCalls, 1);
  assertEquals(harness.removeListenerCalls, 1);
  assertEquals(refreshes, 1);
});
