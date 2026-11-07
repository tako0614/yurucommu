import { atom, type Getter, type WritableAtom } from "jotai/vanilla";

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
const legacyKeys = {
  content: "compose.draft.content",
  summary: "compose.draft.summary",
  visibility: "compose.draft.visibility",
};

function storageKeys(namespace?: string) {
  return namespace
    ? {
        content: `${namespace}.content`,
        summary: `${namespace}.summary`,
        visibility: `${namespace}.visibility`,
      }
    : legacyKeys;
}

// Preserve the three-field JSON format within an explicitly selected namespace.
// The omitted namespace is only the low-level legacy reader/test seam.
export function readStoredPostDraft(
  storage: Pick<Storage, "getItem">,
  namespace?: string,
): PostDraft | null {
  const keys = storageKeys(namespace);
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
  namespace?: string,
) {
  const keys = storageKeys(namespace);
  const state = atom({ draft: { ...emptyDraft }, writeFailed: false });
  const equal = (a: PostDraft, b: PostDraft) =>
    a.content === b.content &&
    a.summary === b.summary &&
    a.visibility === b.visibility;
  const read = (): PostDraft | null => {
    try {
      return readStoredPostDraft(getStorage(), namespace);
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

export type PostDraftScope = Readonly<{
  origin: string;
  actorApId: string;
  instanceId: string | null;
  hostedUserId: string | null;
}>;

/** A persistent owner tuple, never an authentication or server-session claim. */
export function postDraftNamespace(scope: PostDraftScope): string {
  const origin = new URL(scope.origin);
  if (!["https:", "http:"].includes(origin.protocol) || !scope.actorApId) {
    throw new Error("A draft requires an observed actor and HTTP API origin");
  }
  return `compose.draft.v2.${encodeURIComponent(
    JSON.stringify([
      origin.origin,
      scope.actorApId,
      scope.instanceId,
      scope.hostedUserId,
    ]),
  )}`;
}

export function createScopedPostDraftAtoms(
  resolveScope: (get: Getter) => PostDraftScope | null,
  getStorage: () => DraftStorage = () => globalThis.localStorage,
  events: DraftEventSource | undefined = typeof window === "undefined"
    ? undefined
    : window,
) {
  // Only atom configurations are cached here. Draft values, dirty state and
  // subscriptions stay in the caller's Jotai store, as in the base helper.
  const configurations = new Map<
    string,
    ReturnType<typeof createPostDraftAtoms>
  >();
  const resolveNamespace = (get: Getter) => {
    try {
      const scope = resolveScope(get);
      return scope ? postDraftNamespace(scope) : null;
    } catch {
      return null;
    }
  };
  const namespaceAtom = atom(resolveNamespace);
  const current = (get: Getter) => {
    const namespace = get(namespaceAtom);
    if (!namespace || namespace !== resolveNamespace(get)) return null;
    let draft = configurations.get(namespace);
    if (!draft) {
      draft = createPostDraftAtoms(getStorage, events, namespace);
      configurations.set(namespace, draft);
    }
    return draft;
  };
  type DraftAtoms = ReturnType<typeof createPostDraftAtoms>;
  const field = <T>(
    select: (draft: DraftAtoms) => WritableAtom<T, [T], void>,
    fallback: T,
  ) =>
    atom(
      (get) => {
        const draft = current(get);
        return draft ? get(select(draft)) : fallback;
      },
      (get, set, value: T) => {
        const draft = current(get);
        if (draft) set(select(draft), value);
      },
    );
  const legacyRevisionAtom = atom(0);
  legacyRevisionAtom.onMount = (setRevision) => {
    const changed = (event: Event) => {
      const change = event as StorageEvent;
      try {
        if (
          change.storageArea === getStorage() &&
          (change.key === null ||
            Object.values(legacyKeys).includes(change.key))
        )
          setRevision((value) => value + 1);
      } catch {
        /* inaccessible bytes remain untouched */
      }
    };
    events?.addEventListener("storage", changed);
    return () => events?.removeEventListener("storage", changed);
  };
  const legacy = () => {
    try {
      const storage = getStorage();
      const fields = Object.fromEntries(
        Object.values(legacyKeys).map((key) => [key, storage.getItem(key)]),
      );
      const parsed = readStoredPostDraft(storage);
      const present = parsed
        ? parsed.content !== "" ||
          parsed.summary !== "" ||
          parsed.visibility !== "public"
        : Object.values(fields).some((value) => value !== null);
      return present ? fields : null;
    } catch {
      return null;
    }
  };
  return {
    namespaceAtom,
    capture: current,
    contentAtom: field((draft) => draft.contentAtom, ""),
    summaryAtom: field((draft) => draft.summaryAtom, ""),
    visibilityAtom: field(
      (draft) => draft.visibilityAtom,
      "public" as PostVisibility,
    ),
    writeFailedAtom: atom((get) => {
      const draft = current(get);
      return draft ? get(draft.writeFailedAtom) : true;
    }),
    refreshAtom: atom(null, (get, set) => {
      const draft = current(get);
      return draft ? set(draft.refreshAtom) : null;
    }),
    clearAtom: atom(null, (get, set) => {
      const draft = current(get);
      return draft ? set(draft.clearAtom) : false;
    }),
    saveAtom: atom(null, (get, set) => {
      const draft = current(get);
      return draft ? set(draft.saveAtom) : false;
    }),
    read: (get: Getter) => current(get)?.read() ?? null,
    legacyAvailableAtom: atom((get) => {
      get(legacyRevisionAtom);
      return get(namespaceAtom) !== null && legacy() !== null;
    }),
    exportLegacyAtom: atom(null, (get) => {
      if (get(namespaceAtom) === null) return null;
      const fields = legacy();
      return fields
        ? JSON.stringify(
            { format: "yurucommu-unassigned-draft-v1", fields },
            null,
            2,
          )
        : null;
    }),
  };
}
