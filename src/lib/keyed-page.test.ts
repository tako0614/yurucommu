import { expect, test } from "bun:test";
import {
  appendKeyedPageInPlace,
  appendUniqueKeyedPageInPlace,
  createKeyedPageOwner,
  removeKeyedItemsInPlace,
  replaceKeyedPageInPlace,
  selectItemsUnseenBeforePage,
} from "./keyed-page.ts";

interface Row {
  id: string;
  value: number;
}

const rowKey = (row: Row) => row.id;

test("selects against the prior-page snapshot while retaining same-page duplicates", () => {
  const existing = { id: "existing", value: 0 };
  const first = { id: "new", value: 1 };
  const duplicate = { id: "new", value: 2 };
  const later = { id: "later", value: 3 };
  const page = [existing, first, duplicate, later];
  const pageSnapshot = [...page];
  const seen = new Set(["existing"]);

  const result = selectItemsUnseenBeforePage(page, seen, rowKey);

  expect(result.keys).toEqual(["new", "new", "later"]);
  expect(result.items).toEqual([first, duplicate, later]);
  expect(result.items[0]).toBe(first);
  expect(result.items[1]).toBe(duplicate);
  expect(result.items[2]).toBe(later);
  expect(page).toEqual(pageSnapshot);
  expect(seen).toEqual(new Set(["existing"]));
});

test("replacement resets old keys and keeps the owned target identity", () => {
  const first = { id: "new", value: 1 };
  const duplicate = { id: "new", value: 2 };
  const page = [first, duplicate];
  const target = [{ id: "old", value: 0 }];
  const seen = new Set(["old"]);

  const result = replaceKeyedPageInPlace(target, seen, page, rowKey);

  expect(result).toBe(target);
  expect(result).not.toBe(page);
  expect(target).toEqual(page);
  expect(target[0]).toBe(first);
  expect(target[1]).toBe(duplicate);
  expect(seen).toEqual(new Set(["new"]));
});

test("replacement is safe when the owned target is also the source page", () => {
  const first = { id: "first", value: 1 };
  const second = { id: "second", value: 2 };
  const target = [first, second];
  const seen = new Set(["stale"]);

  const result = replaceKeyedPageInPlace(target, seen, target, rowKey);

  expect(result).toBe(target);
  expect(target).toEqual([first, second]);
  expect(seen).toEqual(new Set(["first", "second"]));
});

test("append rejects prior-page keys but preserves new order and references", () => {
  const old = { id: "old", value: 0 };
  const first = { id: "new", value: 1 };
  const duplicate = { id: "new", value: 2 };
  const page = [{ id: "old", value: 9 }, first, duplicate];
  const pageSnapshot = [...page];
  const target = [old];
  const seen = new Set(["old"]);

  const result = appendKeyedPageInPlace(target, seen, page, rowKey);

  expect(result).toBe(target);
  expect(target).toEqual([old, first, duplicate]);
  expect(target[1]).toBe(first);
  expect(target[2]).toBe(duplicate);
  expect(seen).toEqual(new Set(["old", "new"]));
  expect(page).toEqual(pageSnapshot);
});

test("unique append also rejects duplicates introduced within the incoming page", () => {
  const existingDuplicateA = { id: "existing", value: 0 };
  const existingDuplicateB = { id: "existing", value: 1 };
  const first = { id: "new", value: 2 };
  const duplicate = { id: "new", value: 3 };
  const last = { id: "last", value: 4 };
  const page = [{ id: "existing", value: 9 }, first, duplicate, last];
  const pageSnapshot = [...page];
  const target = [existingDuplicateA, existingDuplicateB];
  const seen = new Set(["existing"]);

  const result = appendUniqueKeyedPageInPlace(target, seen, page, rowKey);

  expect(result).toBe(target);
  expect(target).toEqual([existingDuplicateA, existingDuplicateB, first, last]);
  expect(target[2]).toBe(first);
  expect(target[3]).toBe(last);
  expect(seen).toEqual(new Set(["existing", "new", "last"]));
  expect(page).toEqual(pageSnapshot);
});

test("removal compacts every matching key without replacing retained rows", () => {
  const first = { id: "first", value: 1 };
  const removed = { id: "remove", value: 2 };
  const duplicate = { id: "remove", value: 3 };
  const last = { id: "last", value: 4 };
  const target = [first, removed, duplicate, last];
  const seen = new Set(["first", "remove", "last"]);

  const result = removeKeyedItemsInPlace(target, seen, "remove", rowKey);

  expect(result).toBe(target);
  expect(target).toEqual([first, last]);
  expect(target[0]).toBe(first);
  expect(target[1]).toBe(last);
  expect(seen).toEqual(new Set(["first", "last"]));
});

test("removal uses the same key equality as Set", () => {
  const removed = { key: Number.NaN };
  const retained = { key: 1 };
  const target = [removed, retained];
  const seen = new Set([Number.NaN, 1]);

  removeKeyedItemsInPlace(target, seen, Number.NaN, (item) => item.key);

  expect(target).toEqual([retained]);
  expect(seen).toEqual(new Set([1]));
});

test("reads each incoming key once across 500 pages without replacing the target", () => {
  let keyReads = 0;
  const pages: Row[][] = [];
  const expected: Row[] = [];

  for (let pageIndex = 0; pageIndex < 500; pageIndex += 1) {
    const page: Row[] = [];
    for (let rowIndex = 0; rowIndex < 20; rowIndex += 1) {
      const id = `row-${pageIndex}-${rowIndex}`;
      const item = { id, value: rowIndex };
      page.push(item);
      expected.push(item);
    }
    pages.push(page);
  }

  const keyOf = (row: Row) => {
    keyReads += 1;
    return row.id;
  };
  const target: Row[] = [];
  const seen = new Set<string>();

  let result = replaceKeyedPageInPlace(target, seen, pages[0], keyOf);
  for (let pageIndex = 1; pageIndex < pages.length; pageIndex += 1) {
    result = appendKeyedPageInPlace(target, seen, pages[pageIndex], keyOf);
    expect(result).toBe(target);
  }

  expect(keyReads).toBe(10_000);
  expect(result).toBe(target);
  expect(target).toHaveLength(10_000);
  for (let index = 0; index < expected.length; index += 1) {
    expect(target[index]).toBe(expected[index]);
  }
});

test("one owner keeps array and key-index lifecycle changes together", () => {
  const owner = createKeyedPageOwner<Row, string>(rowKey);
  const existing = { id: "existing", value: 0 };
  const pageDuplicateA = { id: "page", value: 1 };
  const pageDuplicateB = { id: "page", value: 2 };

  expect(owner.current()).toEqual([]);
  const initial = owner.replace([existing]);
  expect(initial).toBe(owner.current());

  const paged = owner.appendPage([
    { id: "existing", value: 9 },
    pageDuplicateA,
    pageDuplicateB,
  ]);
  expect(paged).toBe(initial);
  expect(paged).toEqual([existing, pageDuplicateA, pageDuplicateB]);

  const unique = { id: "unique", value: 3 };
  owner.appendUniquePage([pageDuplicateA, unique, { ...unique }]);
  expect(owner.current()).toEqual([
    existing,
    pageDuplicateA,
    pageDuplicateB,
    unique,
  ]);

  const localDuplicate = { id: "unique", value: 4 };
  owner.appendItem(localDuplicate);
  expect(owner.current().at(-1)).toBe(localDuplicate);

  const beforeUpdate = owner.current();
  const updated = owner.updatePreservingKeys((items) =>
    items.map((item) => ({ ...item, value: item.value + 10 })),
  );
  expect(updated).not.toBe(beforeUpdate);
  expect(updated).toBe(owner.current());

  owner.appendPage([{ id: "existing", value: 99 }]);
  expect(owner.current()).toHaveLength(updated.length);

  const removed = owner.remove("page");
  expect(removed).toBe(owner.current());
  expect(removed.map(rowKey)).toEqual(["existing", "unique", "unique"]);

  owner.updateAndReindex((items) =>
    items.filter((item) => item.id !== "existing"),
  );
  const restoredExisting = { id: "existing", value: 100 };
  owner.appendPage([restoredExisting]);
  expect(owner.current().at(-1)).toBe(restoredExisting);
});
