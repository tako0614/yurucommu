type Message = { id: string; created_at: string };
type Page<T> = { messages: T[]; hasMore: boolean };
export type DMHistoryToken = object;
export type DMHistorySnapshot<T> = {
  messages: T[];
  loading: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  error: null | "initial" | "older";
};

/** The backend cursor uses ascending (published, apId), including ties. */
export function mergeDMHistory<T extends Message>(
  previous: T[],
  incoming: T[],
): T[] {
  const byId = new Map(previous.map((message) => [message.id, message]));
  for (const message of incoming) {
    const known = byId.get(message.id);
    byId.set(
      message.id,
      known && JSON.stringify(known) === JSON.stringify(message)
        ? known
        : message,
    );
  }
  const merged = [...byId.values()].sort((a, b) => {
    const left = a.created_at === b.created_at ? a.id : a.created_at;
    const right = a.created_at === b.created_at ? b.id : b.created_at;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return merged.length === previous.length &&
    merged.every((message, index) => message === previous[index])
    ? previous
    : merged;
}

/** State belongs to one panel activation, including each A -> B -> A visit. */
export function createDMHistory<T extends Message>(
  publish: (snapshot: DMHistorySnapshot<T>) => void = () => {},
) {
  const empty = (): DMHistorySnapshot<T> => ({
    messages: [],
    loading: true,
    hasMore: false,
    loadingOlder: false,
    error: null,
  });
  let state = empty();
  let active: DMHistoryToken | null = null;
  let nextRead = 0;
  let acceptedRead = 0;
  let paginated = false;
  let pager: object | null = null;
  let mutation = 0;
  const writes = new Map<string, { sequence: number; removed: boolean }>();
  const owns = (token: DMHistoryToken) => active === token;
  const update = (patch: Partial<DMHistorySnapshot<T>>) => {
    state = { ...state, ...patch };
    publish(state);
  };
  const reconcile = (messages: T[], started: number) =>
    messages.filter((message) => {
      const write = writes.get(message.id);
      return !write || (!write.removed && write.sequence <= started);
    });

  return {
    owns,
    snapshot: () => state,
    activate: (): DMHistoryToken => {
      const token = {};
      active = token;
      nextRead = acceptedRead = mutation = 0;
      paginated = false;
      pager = null;
      writes.clear();
      state = empty();
      publish(state);
      return token;
    },
    invalidate: (token: DMHistoryToken) => {
      if (owns(token)) active = null;
    },
    readNewest: async (
      token: DMHistoryToken,
      mode: "initial" | "poll",
      read: () => Promise<Page<T>>,
    ): Promise<{ applied: boolean; changed: boolean }> => {
      const ignored = { applied: false, changed: false };
      if (!owns(token)) return ignored;
      const sequence = ++nextRead;
      const started = mutation;
      const current = () => owns(token) && sequence > acceptedRead;
      let page: Page<T>;
      try {
        page = await read();
      } catch {
        // An ACK is usable even when its pending initial history fails. Failed
        // polls do not retire useful initial reads or replace confirmed rows.
        if (current() && mode === "initial") {
          update({
            loading: false,
            error: state.messages.length === 0 ? "initial" : state.error,
          });
        }
        return ignored;
      }
      if (!current()) return ignored;
      // API 4.1.11 maps absent DM messages to [], including error bodies. An
      // empty poll cannot establish deletion or supersede a pending initial.
      const fetched = reconcile(page.messages, started);
      if (mode === "poll" && fetched.length === 0) return ignored;
      acceptedRead = sequence;
      const messages = mergeDMHistory(state.messages, fetched);
      const changed = messages !== state.messages;
      update({
        messages,
        loading: false,
        error: state.error === "initial" ? null : state.error,
        ...(!paginated && fetched.length > 0 ? { hasMore: page.hasMore } : {}),
      });
      return owns(token) ? { applied: true, changed } : ignored;
    },
    acknowledge: (token: DMHistoryToken, message: T) => {
      if (!owns(token)) return;
      writes.set(message.id, { sequence: ++mutation, removed: false });
      update({
        messages: state.messages.some((known) => known.id === message.id)
          ? state.messages
          : mergeDMHistory(state.messages, [message]),
        loading: false,
        error: state.error === "initial" ? null : state.error,
      });
    },
    remove: (token: DMHistoryToken, id: string) => {
      if (!owns(token)) return;
      writes.set(id, { sequence: ++mutation, removed: true });
      update({
        messages: state.messages.filter((message) => message.id !== id),
      });
    },
    readOlder: async (
      token: DMHistoryToken,
      read: (cursor: string) => Promise<Page<T>>,
    ): Promise<{ isCurrent: () => boolean } | null> => {
      const oldest = state.messages[0];
      if (!owns(token) || pager || !state.hasMore || !oldest?.created_at)
        return null;
      const operation = {};
      const started = mutation;
      pager = operation;
      paginated = true;
      const current = () => owns(token) && pager === operation;
      update({ loadingOlder: true, error: null });
      if (!current()) return null;
      let applied = false;
      let appliedMessages: T[] | null = null;
      try {
        const page = await read(`${oldest.created_at} ${oldest.id}`);
        if (!current()) return null;
        const knownIds = new Set(state.messages.map((message) => message.id));
        const fresh = reconcile(page.messages, started).filter(
          (message) => !knownIds.has(message.id),
        );
        const messages = mergeDMHistory(state.messages, fresh);
        applied = messages !== state.messages;
        appliedMessages = messages;
        const nextOldest = messages[0];
        const advanced =
          nextOldest &&
          (nextOldest.created_at < oldest.created_at ||
            (nextOldest.created_at === oldest.created_at &&
              nextOldest.id < oldest.id));
        update({
          messages,
          // Preserve the cursor/button for an ambiguous empty SDK response.
          ...(advanced ? { hasMore: page.hasMore } : {}),
        });
      } catch {
        if (current()) update({ error: "older" });
      } finally {
        if (current()) {
          pager = null;
          update({ loadingOlder: false });
        }
      }
      // Cleanup releases the request latch; the activation still owns scroll.
      const isCurrent = () => owns(token) && state.messages === appliedMessages;
      return applied && isCurrent() ? { isCurrent } : null;
    },
  };
}
