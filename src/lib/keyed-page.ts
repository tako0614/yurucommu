export interface KeyedPageSelection<T, K> {
  items: T[];
  keys: K[];
}

export interface KeyedPageOwner<T, K> {
  current(): T[];
  replace(page: readonly T[]): T[];
  appendPage(page: readonly T[]): T[];
  appendUniquePage(page: readonly T[]): T[];
  appendItem(item: T): T[];
  remove(key: K): T[];
  /** The updater must preserve the exact set of item keys. */
  updatePreservingKeys(updater: (previous: T[]) => T[]): T[];
  /** Adopt a locally computed list and rebuild its key index once. */
  updateAndReindex(updater: (previous: T[]) => T[]): T[];
}

/**
 * Select rows whose keys were absent before this page started.
 *
 * Keys introduced by another row in the same page are intentionally not added
 * to the snapshot while selecting. This preserves duplicate rows, order, and
 * object references exactly as supplied by the API.
 */
export function selectItemsUnseenBeforePage<T, K>(
  page: readonly T[],
  seenSnapshot: ReadonlySet<K>,
  keyOf: (item: T) => K,
): KeyedPageSelection<T, K> {
  const items: T[] = [];
  const keys: K[] = [];

  for (const item of page) {
    const key = keyOf(item);
    if (seenSnapshot.has(key)) continue;
    items.push(item);
    keys.push(key);
  }

  return { items, keys };
}

/** Replace an owned page in place and return that same owned array. */
export function replaceKeyedPageInPlace<T, K>(
  target: T[],
  seen: Set<K>,
  page: readonly T[],
  keyOf: (item: T) => K,
): T[] {
  seen.clear();

  // A state updater can legitimately hand its owned array back to us. Rebuild
  // the index without clearing the only copy of its rows.
  if (page === target) {
    for (const item of target) seen.add(keyOf(item));
    return target;
  }

  target.length = 0;
  for (const item of page) {
    target.push(item);
    seen.add(keyOf(item));
  }
  return target;
}

/** Append rows unseen before this page and return the same owned array. */
export function appendKeyedPageInPlace<T, K>(
  target: T[],
  seen: Set<K>,
  page: readonly T[],
  keyOf: (item: T) => K,
): T[] {
  const { items, keys } = selectItemsUnseenBeforePage(page, seen, keyOf);
  for (const item of items) target.push(item);
  for (const key of keys) seen.add(key);
  return target;
}

/**
 * Append rows whose keys have not appeared in the owned list or earlier in
 * this page. Existing duplicate rows remain untouched.
 */
export function appendUniqueKeyedPageInPlace<T, K>(
  target: T[],
  seen: Set<K>,
  page: readonly T[],
  keyOf: (item: T) => K,
): T[] {
  for (const item of page) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(item);
  }
  return target;
}

/** Remove every row with a key while keeping the owned array identity. */
export function removeKeyedItemsInPlace<T, K>(
  target: T[],
  seen: Set<K>,
  key: K,
  keyOf: (item: T) => K,
): T[] {
  let writeIndex = 0;
  for (const item of target) {
    const itemKey = keyOf(item);
    // Set uses SameValueZero: unlike ===, it treats NaN as equal to itself.
    if (itemKey === key || Object.is(itemKey, key)) continue;
    target[writeIndex] = item;
    writeIndex += 1;
  }
  target.length = writeIndex;
  seen.delete(key);
  return target;
}

/** Own one mutable page and its key index behind explicit lifecycle methods. */
export function createKeyedPageOwner<T, K>(
  keyOf: (item: T) => K,
): KeyedPageOwner<T, K> {
  let items: T[] = [];
  const seen = new Set<K>();

  return {
    current: () => items,
    replace: (page) => replaceKeyedPageInPlace(items, seen, page, keyOf),
    appendPage: (page) => appendKeyedPageInPlace(items, seen, page, keyOf),
    appendUniquePage: (page) =>
      appendUniqueKeyedPageInPlace(items, seen, page, keyOf),
    appendItem: (item) => {
      seen.add(keyOf(item));
      items.push(item);
      return items;
    },
    remove: (key) => removeKeyedItemsInPlace(items, seen, key, keyOf),
    updatePreservingKeys: (updater) => {
      items = updater(items);
      return items;
    },
    updateAndReindex: (updater) => {
      items = updater(items);
      seen.clear();
      for (const item of items) seen.add(keyOf(item));
      return items;
    },
  };
}
