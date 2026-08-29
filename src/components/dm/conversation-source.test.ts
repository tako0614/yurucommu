import { assertEquals, assertRejects, assertStrictEquals } from "#test/assert";
import { test } from "bun:test";
import type { CommunityMessage } from "../../lib/api.ts";
import type { DMMessage } from "../../types/index.ts";
import { createConversationSource } from "./conversation-source.ts";

const CONTACT_ID = "https://example.com/ap/users/alice";
const OPAQUE_BEFORE = "2026-01-01T00:00:00.000Z\u0000opaque-message-id";

function makeSender() {
  return {
    ap_id: "https://example.com/ap/users/alice",
    username: "alice@example.com",
    preferred_username: "alice",
    name: "Alice",
    icon_url: null,
  };
}

function makeUserMessage(id: string): DMMessage {
  return {
    id,
    sender: makeSender(),
    content: `user ${id}`,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function makeCommunityMessage(id: string): CommunityMessage {
  return {
    id,
    sender: makeSender(),
    content: `community ${id}`,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

async function assertSameRejection(
  operation: () => Promise<unknown>,
  expected: unknown,
): Promise<void> {
  const actual = await assertRejects(operation);
  assertStrictEquals(actual, expected);
}

test("user source forwards opaque cursors, unwraps sends, and marks user read", async () => {
  const pageMessage = makeUserMessage("user-page");
  const sentMessage = makeUserMessage("user-sent");
  let fetchedContactId: string | undefined;
  let fetchedBefore: string | undefined;
  let sent: { contactId: string; text: string } | undefined;
  let markedContactId: string | undefined;

  const source = createConversationSource("user", {
    user: {
      fetchMessages: async (contactId, options) => {
        fetchedContactId = contactId;
        fetchedBefore = options?.before;
        return { messages: [pageMessage], hasMore: true };
      },
      sendMessage: async (contactId, text) => {
        sent = { contactId, text };
        return { message: sentMessage, conversation_id: "conversation-1" };
      },
      markRead: async (contactId) => {
        markedContactId = contactId;
      },
    },
  });

  const page = await source.fetchPage(CONTACT_ID, { before: OPAQUE_BEFORE });
  assertStrictEquals(page.messages[0], pageMessage);
  assertEquals(page.hasMore, true);
  assertEquals(fetchedContactId, CONTACT_ID);
  assertEquals(fetchedBefore, OPAQUE_BEFORE);

  const message = await source.send(CONTACT_ID, "hello user");
  assertStrictEquals(message, sentMessage);
  assertEquals(sent, { contactId: CONTACT_ID, text: "hello user" });

  await source.markRead(CONTACT_ID);
  assertEquals(markedContactId, CONTACT_ID);
});

test("community source forwards opaque cursors, preserves pages, and marks community read", async () => {
  const pageMessage = makeCommunityMessage("community-page");
  const sentMessage = makeCommunityMessage("community-sent");
  let fetchedContactId: string | undefined;
  let fetchedBefore: string | undefined;
  let sent: { contactId: string; text: string } | undefined;
  let markedContactId: string | undefined;

  const source = createConversationSource("community", {
    community: {
      fetchMessages: async (contactId, options) => {
        fetchedContactId = contactId;
        fetchedBefore = options?.before;
        return { messages: [pageMessage], hasMore: false };
      },
      sendMessage: async (contactId, text) => {
        sent = { contactId, text };
        return sentMessage;
      },
      markRead: async (contactId) => {
        markedContactId = contactId;
      },
    },
  });

  const page = await source.fetchPage("community-1", {
    before: OPAQUE_BEFORE,
  });
  assertStrictEquals(page.messages[0], pageMessage);
  assertEquals(page.hasMore, false);
  assertEquals(fetchedContactId, "community-1");
  assertEquals(fetchedBefore, OPAQUE_BEFORE);

  const message = await source.send("community-1", "hello community");
  assertStrictEquals(message, sentMessage);
  assertEquals(sent, { contactId: "community-1", text: "hello community" });

  await source.markRead("community-1");
  assertEquals(markedContactId, "community-1");
});

test("user source propagates operation errors unchanged", async () => {
  const error = new Error("user transport failed");
  const source = createConversationSource("user", {
    user: {
      fetchMessages: async () => {
        throw error;
      },
      sendMessage: async () => {
        throw error;
      },
      markRead: async () => {
        throw error;
      },
    },
  });

  await assertSameRejection(() => source.fetchPage(CONTACT_ID), error);
  await assertSameRejection(() => source.send(CONTACT_ID, "hello"), error);
  await assertSameRejection(() => source.markRead(CONTACT_ID), error);
});

test("community source propagates operation errors unchanged", async () => {
  const error = new Error("community transport failed");
  const source = createConversationSource("community", {
    community: {
      fetchMessages: async () => {
        throw error;
      },
      sendMessage: async () => {
        throw error;
      },
      markRead: async () => {
        throw error;
      },
    },
  });

  await assertSameRejection(() => source.fetchPage("community-1"), error);
  await assertSameRejection(() => source.send("community-1", "hello"), error);
  await assertSameRejection(() => source.markRead("community-1"), error);
});
