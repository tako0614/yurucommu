import { atom } from "jotai/vanilla";

export type PostVisibility = "public" | "unlisted" | "followers" | "direct";
export type PostDraft = {
  content: string;
  summary: string;
  visibility: PostVisibility;
};

const emptyDraft: PostDraft = {
  content: "",
  summary: "",
  visibility: "public",
};
const keys = {
  content: "compose.draft.content",
  summary: "compose.draft.summary",
  visibility: "compose.draft.visibility",
};

// Keep the existing three JSON keys. Missing keys mean defaults; malformed or
// inaccessible storage cannot authorize acknowledgement-time draft clearing.
export function readStoredPostDraft(
  storage: Pick<Storage, "getItem">,
): PostDraft | null {
  try {
    const read = (field: keyof PostDraft): unknown => {
      const raw = storage.getItem(keys[field]);
      return raw === null ? emptyDraft[field] : JSON.parse(raw);
    };
    const content = read("content");
    const summary = read("summary");
    const visibility = read("visibility");
    if (
      typeof content !== "string" ||
      typeof summary !== "string" ||
      !["public", "unlisted", "followers", "direct"].includes(
        String(visibility),
      ) ||
      typeof visibility !== "string"
    )
      return null;
    return { content, summary, visibility: visibility as PostVisibility };
  } catch {
    return null;
  }
}

type DraftStorage = Pick<Storage, "getItem" | "setItem">;
type DraftEventSource = Pick<
  Window,
  "addEventListener" | "removeEventListener"
>;

export function createPostDraftAtoms(
  getStorage: () => DraftStorage = () => globalThis.localStorage,
  events: DraftEventSource | undefined = typeof window === "undefined"
    ? undefined
    : window,
) {
  const state = atom({ draft: { ...emptyDraft }, writeFailed: false });
  const equal = (a: PostDraft, b: PostDraft) =>
    a.content === b.content &&
    a.summary === b.summary &&
    a.visibility === b.visibility;
  const read = (): PostDraft | null => {
    try {
      return readStoredPostDraft(getStorage());
    } catch {
      return null;
    }
  };
  const recoverableFields = (): Partial<PostDraft> => {
    const recovered: Partial<PostDraft> = {};
    for (const field of Object.keys(keys) as (keyof PostDraft)[]) {
      try {
        const raw = getStorage().getItem(keys[field]);
        const value: unknown =
          raw === null ? emptyDraft[field] : JSON.parse(raw);
        if (typeof value !== "string") continue;
        if (field === "visibility") {
          if (["public", "unlisted", "followers", "direct"].includes(value))
            recovered.visibility = value as PostVisibility;
        } else recovered[field] = value;
      } catch {
        // A damaged field must not hide the other recoverable text/audience.
      }
    }
    return recovered;
  };
  state.onMount = (setState) => {
    const refresh = () => {
      const stored = read();
      if (stored)
        setState((previous) =>
          previous.writeFailed
            ? previous
            : { draft: stored, writeFailed: false },
        );
    };
    const initial = read();
    if (initial)
      setState((previous) =>
        previous.writeFailed
          ? previous
          : { draft: initial, writeFailed: false },
      );
    else
      setState((previous) =>
        previous.writeFailed
          ? previous
          : {
              draft: { ...previous.draft, ...recoverableFields() },
              writeFailed: true,
            },
      );
    const onStorage = (event: Event) => {
      const change = event as StorageEvent;
      try {
        if (
          change.storageArea === getStorage() &&
          (change.key === null || Object.values(keys).includes(change.key))
        )
          refresh();
      } catch {
        // Preserve the current composition if storage becomes unavailable.
      }
    };
    events?.addEventListener("storage", onStorage);
    return () => events?.removeEventListener("storage", onStorage);
  };
  const field = <K extends keyof PostDraft>(name: K) =>
    atom(
      (get) => get(state).draft[name],
      (get, set, value: PostDraft[K]) => {
        const previous = get(state);
        const draft = { ...previous.draft, [name]: value };
        set(state, { draft, writeFailed: previous.writeFailed });
        try {
          getStorage().setItem(keys[name], JSON.stringify(value));
        } catch {
          // The newer composition may exist only in memory. Never replace it
          // with the older raw value when a delayed event or reload arrives.
          set(state, { draft, writeFailed: true });
        }
      },
    );
  const refreshAtom = atom(null, (get, set) => {
    const stored = read();
    const previous = get(state);
    if (!stored || (previous.writeFailed && !equal(stored, previous.draft)))
      return null;
    set(state, { draft: stored, writeFailed: false });
    return stored;
  });
  const clearAtom = atom(null, (get, set) => {
    const previous = get(state);
    try {
      const storage = getStorage();
      for (const field of Object.keys(keys) as (keyof PostDraft)[]) {
        storage.setItem(keys[field], JSON.stringify(emptyDraft[field]));
      }
      set(state, { draft: { ...emptyDraft }, writeFailed: false });
      return true;
    } catch {
      // localStorage has no multi-key transaction. A partial raw clear may
      // have occurred; retain the complete composition in memory for copying.
      set(state, { draft: previous.draft, writeFailed: true });
      return false;
    }
  });
  // Recovery can replace only the body when the saved CW and audience already
  // match. Replacing three independent keys could pair private text with an old
  // public audience after a partial failure. Other conflicts require copying.
  const saveAtom = atom(null, (get, set) => {
    const previous = get(state);
    const stored = read();
    if (
      !stored ||
      stored.summary !== previous.draft.summary ||
      stored.visibility !== previous.draft.visibility
    )
      return false;
    try {
      getStorage().setItem(
        keys.content,
        JSON.stringify(previous.draft.content),
      );
      const saved = read();
      if (!saved || !equal(saved, previous.draft)) {
        set(state, { draft: previous.draft, writeFailed: true });
        return false;
      }
      set(state, { draft: previous.draft, writeFailed: false });
      return true;
    } catch {
      set(state, { draft: previous.draft, writeFailed: true });
      return false;
    }
  });
  return {
    contentAtom: field("content"),
    summaryAtom: field("summary"),
    visibilityAtom: field("visibility"),
    refreshAtom,
    clearAtom,
    saveAtom,
    writeFailedAtom: atom((get) => get(state).writeFailed),
    read,
  };
}

const draft = createPostDraftAtoms();
export const postContentAtom = draft.contentAtom;
export const postSummaryAtom = draft.summaryAtom;
export const postVisibilityAtom = draft.visibilityAtom;
export const refreshPostDraftAtom = draft.refreshAtom;
export const clearStoredPostDraftAtom = draft.clearAtom;
export const saveRetainedPostDraftAtom = draft.saveAtom;
export const postDraftWriteFailedAtom = draft.writeFailedAtom;
export const readPostDraftFromStorage = draft.read;
