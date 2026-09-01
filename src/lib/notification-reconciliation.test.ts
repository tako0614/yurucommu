import { expect, test } from "bun:test";
import type { Notification } from "../types/index.ts";
import { reconcileNewestNotifications } from "./notification-reconciliation.ts";

function makeNotification(
  id: string,
  overrides: Partial<Notification> = {},
): Notification {
  return {
    id,
    type: "like",
    actor: {
      ap_id: "https://example.com/ap/users/alice",
      username: "alice@example.com",
      preferred_username: "alice",
      name: "Alice",
      icon_url: null,
    },
    object_ap_id: null,
    read: false,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("reuses the previous object when an incoming notification is unchanged", () => {
  const previous = [makeNotification("same")];
  const incoming = [makeNotification("same")];

  const result = reconcileNewestNotifications(previous, incoming);

  expect(result[0]).toBe(previous[0]);
});

test("uses the incoming object when a notification changed", () => {
  const previous = [makeNotification("same")];
  const incoming = [makeNotification("same", { read: true })];

  const result = reconcileNewestNotifications(previous, incoming);

  expect(result[0]).toBe(incoming[0]);
  expect(result[0]).not.toBe(previous[0]);
});

test("keeps incoming notifications in incoming order before older rows", () => {
  const previous = [
    makeNotification("older", { created_at: "2026-01-01T00:00:00.000Z" }),
  ];
  const incoming = [
    makeNotification("newest", { created_at: "2026-01-03T00:00:00.000Z" }),
    makeNotification("boundary", { created_at: "2026-01-02T00:00:00.000Z" }),
  ];

  const result = reconcileNewestNotifications(previous, incoming);

  expect(result.slice(0, incoming.length)).toEqual(incoming);
  expect(result[incoming.length]).toBe(previous[0]);
});

test("appends only rows strictly older than the incoming boundary", () => {
  const boundaryCreatedAt = "2026-01-02T00:00:00.000Z";
  const incoming = [
    makeNotification("boundary", { created_at: boundaryCreatedAt }),
  ];
  const previous = [
    makeNotification("boundary", { created_at: boundaryCreatedAt, read: true }),
    makeNotification("a", { created_at: boundaryCreatedAt }),
    makeNotification("z", { created_at: boundaryCreatedAt }),
    makeNotification("newer", { created_at: "2026-01-03T00:00:00.000Z" }),
    makeNotification("older", { created_at: "2026-01-01T00:00:00.000Z" }),
  ];

  const result = reconcileNewestNotifications(previous, incoming);

  expect(result.map((notification) => notification.id)).toEqual([
    "boundary",
    "a",
    "older",
  ]);
  expect(result[0]).toBe(incoming[0]);
  expect(result[1]).toBe(previous[1]);
  expect(result[2]).toBe(previous[4]);
});

test("does not resurrect a previous row from the newest region when it was deleted", () => {
  const previous = [
    makeNotification("deleted", { created_at: "2026-01-03T00:00:00.000Z" }),
    makeNotification("older", { created_at: "2026-01-01T00:00:00.000Z" }),
  ];
  const incoming = [
    makeNotification("boundary", { created_at: "2026-01-02T00:00:00.000Z" }),
  ];

  const result = reconcileNewestNotifications(previous, incoming);

  expect(result.map((notification) => notification.id)).toEqual([
    "boundary",
    "older",
  ]);
});

test("returns an empty list when the incoming newest page is empty", () => {
  const previous = [makeNotification("previous")];

  const result = reconcileNewestNotifications(previous, []);

  expect(result).toEqual([]);
  expect(result).not.toBe(previous);
});

test("preserves duplicate IDs in the incoming page", () => {
  const previous = [
    makeNotification("duplicate", { created_at: "2026-01-01T00:00:00.000Z" }),
    makeNotification("older", { created_at: "2026-01-01T00:00:00.000Z" }),
  ];
  const incoming = [
    makeNotification("duplicate", { created_at: "2026-01-03T00:00:00.000Z" }),
    makeNotification("duplicate", {
      created_at: "2026-01-02T00:00:00.000Z",
      read: true,
    }),
  ];

  const result = reconcileNewestNotifications(previous, incoming);

  expect(result.slice(0, incoming.length)).toEqual(incoming);
  expect(result[0]).toBe(incoming[0]);
  expect(result[1]).toBe(incoming[1]);
  expect(result[2]).toBe(previous[1]);
});

test("does not rescan merged notifications to collect their IDs", () => {
  let idReads = 0;
  const countedNotification = (
    id: string,
    created_at: string,
  ): Notification => {
    const notification = makeNotification(id, { created_at });
    Object.defineProperty(notification, "id", {
      configurable: true,
      enumerable: false,
      get: () => {
        idReads += 1;
        return id;
      },
    });
    return notification;
  };
  const previousCount = 4;
  const incomingCount = 3;
  const previous = Array.from({ length: previousCount }, (_, index) =>
    countedNotification(
      `previous-${index}`,
      `2026-01-0${index + 1}T00:00:00.000Z`,
    ),
  );
  const incoming = Array.from({ length: incomingCount }, (_, index) =>
    countedNotification(
      `incoming-${index}`,
      `2026-02-0${index + 1}T00:00:00.000Z`,
    ),
  );

  const result = reconcileNewestNotifications(previous, incoming);

  expect(result).toHaveLength(previousCount + incomingCount);
  expect(idReads).toBeLessThanOrEqual(2 * previousCount + incomingCount);
});
