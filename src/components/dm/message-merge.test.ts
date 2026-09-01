import { assertEquals, assertStrictEquals } from "#test/assert";
import { test } from "bun:test";
import type { ChatMessage } from "./conversation-source.ts";
import { mergeMessagesById } from "./message-merge.ts";

function makeMessage(id: string, content = id): ChatMessage {
  return {
    id,
    sender: {
      ap_id: "https://example.com/ap/users/alice",
      username: "alice@example.com",
      preferred_username: "alice",
      name: "Alice",
      icon_url: null,
    },
    content,
    created_at: "2026-01-01T00:00:00.000Z",
  } as ChatMessage;
}

function ids(messages: ChatMessage[]): string[] {
  const result: string[] = [];
  for (const message of messages) result.push(message.id);
  return result;
}

test("returns existing when fetched IDs are unchanged", () => {
  const existing = [makeMessage("one", "old one"), makeMessage("two")];
  const fetched = [makeMessage("one", "fresh one"), makeMessage("two")];

  const result = mergeMessagesById(existing, fetched);

  assertStrictEquals(result, existing);
  assertStrictEquals(result[0], existing[0]);
});

test("uses the fetched reference and order when there are no pending messages", () => {
  const existing = [makeMessage("one"), makeMessage("two")];
  const fetched = [
    makeMessage("two", "fresh two"),
    makeMessage("one", "fresh one"),
    makeMessage("three"),
  ];

  const result = mergeMessagesById(existing, fetched);

  assertStrictEquals(result, fetched);
  assertEquals(ids(result), ["two", "one", "three"]);
  assertStrictEquals(result[0], fetched[0]);
});

test("appends pending messages in their existing order", () => {
  const existing = [
    makeMessage("pending-one"),
    makeMessage("known"),
    makeMessage("pending-two"),
  ];
  const fetched = [makeMessage("known", "fresh known")];

  const result = mergeMessagesById(existing, fetched);

  assertEquals(ids(result), ["known", "pending-one", "pending-two"]);
  assertStrictEquals(result[0], fetched[0]);
  assertStrictEquals(result[1], existing[0]);
  assertStrictEquals(result[2], existing[2]);
});

test("preserves duplicate fetched and pending IDs", () => {
  const fetchedOne = makeMessage("known", "first fetched");
  const fetchedTwo = makeMessage("known", "second fetched");
  const duplicateOne = makeMessage("pending", "first pending");
  const duplicateTwo = makeMessage("pending", "second pending");
  const existing = [duplicateOne, duplicateTwo];
  const fetched = [fetchedOne, fetchedTwo];

  const result = mergeMessagesById(existing, fetched);

  assertEquals(ids(result), ["known", "known", "pending", "pending"]);
  assertStrictEquals(result[0], fetchedOne);
  assertStrictEquals(result[1], fetchedTwo);
  assertStrictEquals(result[2], duplicateOne);
  assertStrictEquals(result[3], duplicateTwo);
});

test("returns existing when pending append restores its ID sequence", () => {
  const existing = [makeMessage("one", "old one"), makeMessage("two")];
  const fetched = [makeMessage("one", "fresh one")];

  const result = mergeMessagesById(existing, fetched);

  assertStrictEquals(result, existing);
});

test("same-ID fast path does not call map, filter, or every", () => {
  const existing = [makeMessage("one"), makeMessage("two")];
  const fetched = [makeMessage("one", "fresh one"), makeMessage("two")];
  const methods = ["map", "filter", "every"] as const;

  for (const messages of [existing, fetched]) {
    for (const method of methods) {
      Object.defineProperty(messages, method, {
        configurable: true,
        value: () => {
          throw new Error(`unexpected ${method} call`);
        },
      });
    }
  }

  assertStrictEquals(mergeMessagesById(existing, fetched), existing);
});
