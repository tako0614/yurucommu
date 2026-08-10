import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { A } from "@solidjs/router";
import type { Actor } from "../../types/index.ts";
import {
  deleteCommunityMessage,
  DMContact,
  fetchCommunityMessages,
  fetchUserDMMessages,
  fetchUserDMTyping,
  markCommunityAsRead,
  markDMAsRead,
  sendCommunityMessage,
  sendUserDMMessage,
  sendUserDMTyping,
} from "../../lib/api.ts";
import { ApiError } from "../../lib/api/fetch.ts";
import { formatTime } from "../../lib/datetime.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { ConfirmSheet } from "../ConfirmSheet.tsx";
import { UserAvatar } from "../UserAvatar.tsx";
import {
  type MessageStampSnapshot,
  sendCommunityStamp,
  sendUserDMStamp,
} from "../../lib/api/stamps.ts";
import { StampPicker } from "./StampPicker.tsx";
import { StampPackSheet } from "./StampPackSheet.tsx";
import { type ChatMessage, mergeMessagesById } from "./chat-message-merge.ts";

interface DMChatPanelProps {
  contact: DMContact;
  actor: Actor;
  onBack: () => void;
  onRead?: () => void;
}

// Poll interval for re-fetching incoming messages on the open conversation.
const MESSAGE_POLL_MS = 4000;

export function DMChatPanel(props: DMChatPanelProps) {
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [input, setInput] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [stampPickerOpen, setStampPickerOpen] = createSignal(false);
  const [selectedStamp, setSelectedStamp] =
    createSignal<MessageStampSnapshot | null>(null);
  const [deletingMessage, setDeletingMessage] = createSignal<
    Record<string, boolean>
  >({});
  const [isTyping, setIsTyping] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
  // Whether an OLDER page of messages exists before the oldest one currently
  // shown (DM threads only; the community thread doesn't paginate yet). Set from
  // the initial load + each "load older" fetch — NOT from polls (a poll re-reads
  // the newest page, which always reports older messages exist, and would wrongly
  // resurrect the button after the user has scrolled all the way back).
  const [hasMoreOlder, setHasMoreOlder] = createSignal(false);
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  let messagesEndRef!: HTMLDivElement;
  let scrollContainerRef!: HTMLDivElement;
  let lastTypingSent = 0;
  // Scroll-tracking: remember the previous last-message id and count so the
  // auto-scroll effect only fires when the conversation actually grows, not on
  // every 4s poll (which would yank the user away from history they are reading).
  let prevLastId: string | null = null;
  let prevCount = 0;
  let didInitialScroll = false;
  const { t, language } = useI18n();

  // Delete one of YOUR OWN community-chat messages. The backend enforces
  // author-or-manager ownership; we expose it for own messages (community chat
  // only — DM edit/delete isn't surfaced yet). On success the bubble is removed.
  // The bare tap stages the message behind the shared ConfirmSheet — the tiny
  // inline delete affordance is too easy to hit for an unrecoverable action.
  const [pendingDeleteMessage, setPendingDeleteMessage] =
    createSignal<ChatMessage | null>(null);
  const handleDeleteCommunityMessage = async (msg: ChatMessage) => {
    if (props.contact.type !== "community" || deletingMessage()[msg.id]) return;
    setDeletingMessage((prev) => ({ ...prev, [msg.id]: true }));
    try {
      await deleteCommunityMessage(props.contact.ap_id, msg.id);
      setMessages((prev) => prev.filter((m) => m.id !== msg.id));
    } catch (e) {
      console.error("Failed to delete message:", e);
      setErrorMessage(t("common.error"));
    } finally {
      setDeletingMessage((prev) => ({ ...prev, [msg.id]: false }));
    }
  };

  // Fetch the latest messages for the open conversation. On `initial` load we
  // show the spinner and replace state; on poll refreshes we merge by id so
  // optimistic sends are not lost and there is no flicker.
  const refreshMessages = async (
    contactApId: string,
    contactType: DMContact["type"],
    mode: "initial" | "poll",
    isCancelled: () => boolean,
  ) => {
    if (mode === "initial") {
      setErrorMessage(null);
      setLoading(true);
    }
    try {
      if (contactType === "community") {
        const { messages: data, hasMore } =
          await fetchCommunityMessages(contactApId);
        if (isCancelled()) return;
        if (mode === "initial") setHasMoreOlder(hasMore);
        let changed = false;
        setMessages((prev) => {
          const next =
            mode === "initial" ? data : mergeMessagesById(prev, data);
          changed = next !== prev;
          return next;
        });
        // Only POST mark-as-read on the initial load or when genuinely new
        // content arrived; otherwise every poll triggers a redundant write.
        if (mode === "initial" || changed) {
          try {
            await markCommunityAsRead(contactApId);
            if (!isCancelled()) props.onRead?.();
          } catch {
            // Ignore read marking errors.
          }
        }
      } else {
        const { messages: loadedMessages, hasMore } =
          await fetchUserDMMessages(contactApId);
        if (isCancelled()) return;
        // Only the initial (newest-page) load seeds the older-page indicator;
        // see the hasMoreOlder comment. loadOlder updates it thereafter.
        if (mode === "initial") setHasMoreOlder(hasMore);
        let changed = false;
        setMessages((prev) => {
          const next =
            mode === "initial"
              ? loadedMessages
              : mergeMessagesById(prev, loadedMessages);
          changed = next !== prev;
          return next;
        });
        if (mode === "initial" || changed) {
          try {
            await markDMAsRead(contactApId);
            if (!isCancelled()) props.onRead?.();
          } catch {
            // Ignore read marking errors.
          }
        }
      }
    } catch (e) {
      if (!isCancelled() && mode === "initial") {
        console.error("Failed to load messages:", e);
        setErrorMessage(t("common.error"));
      }
      // Poll failures are transient; keep the last good state silently.
    } finally {
      if (!isCancelled() && mode === "initial") {
        setLoading(false);
      }
    }
  };

  // Load the page of messages OLDER than the oldest one currently shown and
  // prepend it, preserving the reader's scroll position (anchor on the height
  // added above). The `before` cursor is the oldest shown message's composite
  // "<published> <apId>" key; the server returns rows older than that tuple.
  const loadOlder = async () => {
    if (loadingOlder()) return;
    const current = messages();
    if (current.length === 0) return;
    const oldest = current[0]; // messages render oldest-first
    if (!oldest.created_at) return;
    // Bind to the conversation we are loading for: the panel is NOT remounted on
    // a thread switch (persistent <Show>), so a switch A→B mid-await would
    // otherwise prepend A's older page into B's list.
    const sentApId = props.contact.ap_id;
    const sentType = props.contact.type;
    setLoadingOlder(true);
    const el = scrollContainerRef;
    const prevHeight = el?.scrollHeight ?? 0;
    try {
      // Composite cursor "<published> <apId>" so a same-millisecond message at
      // the boundary isn't skipped (server falls back to a legacy bare-published
      // cursor if no space is present). `oldest.id` is the message apId.
      const cursor = `${oldest.created_at} ${oldest.id}`;
      const { messages: older, hasMore } =
        sentType === "community"
          ? await fetchCommunityMessages(sentApId, { before: cursor })
          : await fetchUserDMMessages(sentApId, { before: cursor });
      if (props.contact.ap_id !== sentApId || props.contact.type !== sentType) {
        return; // switched conversations mid-flight
      }
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        const fresh = older.filter((m) => !ids.has(m.id));
        return fresh.length > 0 ? [...fresh, ...prev] : prev;
      });
      setHasMoreOlder(hasMore);
      // Keep the message the user was reading in place after the prepend.
      queueMicrotask(() => {
        if (el) el.scrollTop += el.scrollHeight - prevHeight;
      });
    } catch (e) {
      console.error("Failed to load older messages:", e);
      // Surface the failure (guarded against a mid-flight thread switch) instead
      // of a silent revert that looks like "end of history".
      if (props.contact.ap_id === sentApId && props.contact.type === sentType) {
        setErrorMessage(t("common.error"));
      }
    } finally {
      setLoadingOlder(false);
    }
  };

  // Key the (re)load strictly on the conversation IDENTITY (ap_id + type), NOT
  // the whole `contact` object. The parent re-derives `selectedContact` from a
  // polled contacts list, so it hands us a fresh object reference every few
  // seconds with the SAME ap_id. Tracking the object would re-run this effect on
  // every poll, cancelling the in-flight initial load before its `finally` can
  // clear `loading()` — leaving the panel stuck on "Loading..." forever.
  createEffect(
    on(
      () => [props.contact.ap_id, props.contact.type] as const,
      ([contactApId, contactType]) => {
        let cancelled = false;
        const isCancelled = () => cancelled;

        // Reset scroll tracking so the new conversation jumps to its bottom once.
        prevLastId = null;
        prevCount = 0;
        didInitialScroll = false;
        // Clear the previous thread's messages immediately — otherwise, if the
        // new conversation's fetch fails, conversation A's bubbles render under
        // B's header + the error line.
        setMessages([]);
        setHasMoreOlder(false);
        setStampPickerOpen(false);
        setSelectedStamp(null);

        void refreshMessages(contactApId, contactType, "initial", isCancelled);

        // Re-fetch incoming messages while the conversation is open so messages
        // sent by the other side appear without leaving and re-entering the thread.
        const intervalId = window.setInterval(() => {
          // Skip polling while the tab is backgrounded (wasted requests); the
          // contact-change / focus path refreshes when the user returns.
          if (document.hidden) return;
          void refreshMessages(contactApId, contactType, "poll", isCancelled);
        }, MESSAGE_POLL_MS);

        onCleanup(() => {
          cancelled = true;
          window.clearInterval(intervalId);
        });
      },
    ),
  );

  createEffect(() => {
    const list = messages();
    const lastId = list.length > 0 ? list[list.length - 1].id : null;
    const grewOrChanged = lastId !== prevLastId || list.length !== prevCount;

    // On the very first non-empty render, jump to the bottom regardless of
    // position. After that, only auto-scroll when the conversation actually
    // changed (new/optimistic message) AND the user is already near the bottom,
    // so reading back through history is not interrupted by a poll.
    if (!grewOrChanged) {
      return;
    }

    const isInitial = !didInitialScroll && list.length > 0;
    const el = scrollContainerRef;
    const nearBottom =
      !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;

    prevLastId = lastId;
    prevCount = list.length;

    if (isInitial) {
      didInitialScroll = true;
      messagesEndRef?.scrollIntoView();
    } else if (nearBottom) {
      messagesEndRef?.scrollIntoView({ behavior: "smooth" });
    }
  });

  createEffect(() => {
    const contactApId = props.contact.ap_id;
    const contactType = props.contact.type;

    if (contactType !== "user" || isRemoteContact(contactApId)) {
      setIsTyping(false);
      return;
    }

    let cancelled = false;
    const pollTyping = async () => {
      if (document.hidden) return; // don't poll typing state in a backgrounded tab
      try {
        const typing = await fetchUserDMTyping(contactApId);
        if (!cancelled) {
          setIsTyping(typing.is_typing);
        }
      } catch {
        if (!cancelled) {
          setIsTyping(false);
        }
      }
    };

    pollTyping();
    const intervalId = window.setInterval(pollTyping, 4000);
    onCleanup(() => {
      cancelled = true;
      window.clearInterval(intervalId);
    });
  });

  const sendTyping = async (value: string) => {
    if (props.contact.type !== "user") return;
    if (!value.trim()) return;
    const now = Date.now();
    if (now - lastTypingSent < 2000) return;
    lastTypingSent = now;
    try {
      await sendUserDMTyping(props.contact.ap_id);
    } catch (e) {
      console.error("Failed to send typing:", e);
    }
  };

  const handleSend = async (e: SubmitEvent) => {
    e.preventDefault();
    const text = input().trim();
    if (!text || sending()) return;

    setSending(true);
    setErrorMessage(null);
    // Clear the input at SEND time, not on completion: the input stays editable
    // while the request is in flight, and a completion-time setInput("") would
    // wipe whatever the user typed during the await.
    setInput("");
    // Bind to the target conversation: the panel isn't remounted on a thread
    // switch, so an A→B switch mid-send must not inject A's bubble into B.
    const sentApId = props.contact.ap_id;
    const sentType = props.contact.type;
    const stillOnConversation = () =>
      props.contact.ap_id === sentApId && props.contact.type === sentType;
    try {
      if (sentType === "community") {
        const newMsg = await sendCommunityMessage(sentApId, text);
        // Dedupe by id: a concurrent poll may have already merged this message.
        if (stillOnConversation()) {
          setMessages((prev) =>
            prev.some((m) => m.id === newMsg.id) ? prev : [...prev, newMsg],
          );
        }
      } else {
        const { message } = await sendUserDMMessage(sentApId, text);
        if (stillOnConversation()) {
          setMessages((prev) =>
            prev.some((m) => m.id === message.id) ? prev : [...prev, message],
          );
        }
      }
    } catch (e) {
      console.error("Failed to send message:", e);
      // A community whose post_policy is mods/owners lets ordinary members READ
      // + type but returns 403 with a meaningful body on send; surface it instead
      // of a generic error so the user understands posting is restricted. Guard
      // on the conversation too: if the user switched threads mid-send, this
      // conversation-specific error must not surface under the new thread.
      if (stillOnConversation()) {
        setErrorMessage(
          e instanceof ApiError && e.status === 403
            ? e.message
            : t("common.error"),
        );
        // Restore the failed draft so it isn't lost — but never clobber text
        // the user typed while the send was in flight.
        setInput((cur) => (cur.trim() === "" ? text : cur));
      }
    } finally {
      setSending(false);
    }
  };

  const handleInputChange = (
    e: InputEvent & { currentTarget: HTMLInputElement },
  ) => {
    const value = e.currentTarget.value;
    setInput(value);
    void sendTyping(value);
  };

  const handleSendStamp = async (stampId: string): Promise<boolean> => {
    if (sending()) return false;

    setSending(true);
    setErrorMessage(null);
    const sentApId = props.contact.ap_id;
    const sentType = props.contact.type;
    const stillOnConversation = () =>
      props.contact.ap_id === sentApId && props.contact.type === sentType;
    try {
      const message =
        sentType === "community"
          ? await sendCommunityStamp(sentApId, stampId)
          : (await sendUserDMStamp(sentApId, stampId)).message;
      if (stillOnConversation()) {
        setMessages((current) =>
          current.some((candidate) => candidate.id === message.id)
            ? current
            : [...current, message],
        );
      }
      return true;
    } catch (cause) {
      console.error("Failed to send Stamp:", cause);
      if (stillOnConversation()) {
        setErrorMessage(
          cause instanceof ApiError && cause.status === 403
            ? cause.message
            : t("common.error"),
        );
      }
      return false;
    } finally {
      setSending(false);
    }
  };

  const getSenderApId = (msg: ChatMessage): string => {
    return msg.sender.ap_id;
  };

  // A contact is remote when its AP-ID host differs from this instance's host.
  // Typing indicators are local-only (no federation delivery), so polling a
  // remote peer's typing state can never return true and is a dead 4s request.
  const isRemoteContact = (apId: string): boolean => {
    try {
      return new URL(apId).host !== window.location.host;
    } catch {
      return false;
    }
  };

  return (
    <div class="flex flex-col h-full">
      <div class="flex items-center gap-3 px-4 py-3 border-b border-neutral-900 bg-neutral-900/80 backdrop-blur-sm">
        <button
          onClick={props.onBack}
          aria-label={t("common.back")}
          class="text-neutral-400 hover:text-white transition-colors"
        >
          <svg
            class="w-6 h-6"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </button>
        <UserAvatar
          avatarUrl={props.contact.icon_url ?? null}
          name={props.contact.name || props.contact.preferred_username || "?"}
          size={40}
        />
        <div class="flex-1 min-w-0">
          <div class="font-semibold text-white truncate">
            {props.contact.name || props.contact.preferred_username}
          </div>
          <div class="text-xs text-neutral-500 truncate">
            @{props.contact.preferred_username}
            <Show
              when={
                props.contact.type === "community" &&
                props.contact.member_count !== undefined
              }
            >
              <span class="ml-2">
                {t("dm.memberCount").replace(
                  "{count}",
                  String(props.contact.member_count),
                )}
              </span>
            </Show>
          </div>
        </div>
        <Show when={props.contact.type === "community"}>
          <A
            href={`/groups/${encodeURIComponent(props.contact.preferred_username)}`}
            aria-label={t("dm.openCommunityProfile")}
            title={t("dm.openCommunityProfile")}
            class="flex-shrink-0 p-2 text-neutral-400 hover:text-white transition-colors"
          >
            <svg
              class="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
              />
            </svg>
          </A>
        </Show>
      </div>

      <div
        ref={scrollContainerRef!}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-atomic="false"
        class="flex-1 overflow-y-auto px-4 py-4"
      >
        <Show
          when={!loading()}
          fallback={
            <div class="text-center text-neutral-500">
              {t("common.loading")}
            </div>
          }
        >
          <Show
            when={messages().length > 0}
            fallback={
              <div class="text-center text-neutral-500">
                {props.contact.type === "community"
                  ? t("communityChat.noMessages")
                  : t("dm.noMessages")}
              </div>
            }
          >
            <Show when={hasMoreOlder()}>
              <div class="flex justify-center pb-3">
                <button
                  onClick={loadOlder}
                  disabled={loadingOlder()}
                  class="rounded-full bg-neutral-800 px-4 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700 transition-colors disabled:opacity-50"
                >
                  {loadingOlder() ? t("common.loading") : t("dm.loadOlder")}
                </button>
              </div>
            </Show>
            <For each={messages()}>
              {(msg, index) => {
                // Functions, not consts: `index()` shifts when loadOlder
                // PREPENDS a page, and a captured const would freeze the
                // sender-grouping decision at row-creation time (stale avatar
                // at the old page boundary).
                const isMine = () => getSenderApId(msg) === props.actor.ap_id;
                const showAvatar = () =>
                  !isMine() &&
                  (index() === 0 ||
                    getSenderApId(messages()[index() - 1]) !==
                      getSenderApId(msg));

                return (
                  <div
                    class={`flex ${
                      isMine() ? "justify-end" : "justify-start"
                    } mb-2`}
                  >
                    <Show
                      when={!isMine() && showAvatar()}
                      fallback={
                        !isMine() ? <div class="w-8 mr-2" /> : undefined
                      }
                    >
                      <UserAvatar
                        avatarUrl={msg.sender.icon_url || null}
                        name={
                          msg.sender.name ||
                          msg.sender.preferred_username ||
                          "?"
                        }
                        size={32}
                        class="mr-2"
                      />
                    </Show>
                    <div
                      class={`max-w-[70%] ${
                        isMine() ? "text-right" : "text-left"
                      }`}
                    >
                      <Show when={!isMine() && showAvatar()}>
                        <div class="text-xs text-neutral-500 mb-1">
                          {msg.sender.name || msg.sender.preferred_username}
                        </div>
                      </Show>
                      <Show
                        when={msg.stamp}
                        fallback={
                          <div
                            class={`inline-block px-4 py-2 rounded-2xl ${
                              isMine()
                                ? "bg-accent text-white rounded-br-sm"
                                : "bg-neutral-800 text-white rounded-bl-sm"
                            }`}
                          >
                            <p class="text-sm whitespace-pre-wrap break-words">
                              {msg.content}
                            </p>
                          </div>
                        }
                      >
                        {(stamp) => (
                          <button
                            type="button"
                            onClick={() => setSelectedStamp(stamp())}
                            aria-label={stamp().alt}
                            title={stamp().alt}
                            class="block rounded-2xl p-1 transition-transform hover:scale-[1.03] focus:outline-none focus:ring-2 focus:ring-accent"
                          >
                            <img
                              src={stamp().asset.url}
                              alt={stamp().alt}
                              loading="lazy"
                              class="h-36 w-36 object-contain sm:h-40 sm:w-40"
                            />
                          </button>
                        )}
                      </Show>
                      <div class="text-xs text-neutral-500 mt-1">
                        {formatTime(msg.created_at, language())}
                        <Show
                          when={isMine() && props.contact.type === "community"}
                        >
                          <button
                            type="button"
                            onClick={() => setPendingDeleteMessage(msg)}
                            disabled={deletingMessage()[msg.id]}
                            class="ml-2 text-rose-400 hover:text-rose-300 disabled:opacity-50"
                          >
                            {t("common.delete")}
                          </button>
                        </Show>
                      </div>
                    </div>
                  </div>
                );
              }}
            </For>
          </Show>
        </Show>
        <Show when={props.contact.type === "user" && isTyping()}>
          <div class="text-xs text-neutral-500 mt-2">{t("dm.typing")}</div>
        </Show>
        <Show when={errorMessage()}>
          <div class="mt-4 text-center text-red-400 text-sm">
            {errorMessage()}
          </div>
        </Show>
        <div ref={messagesEndRef!} />
      </div>

      <StampPicker
        open={stampPickerOpen()}
        language={language()}
        onClose={() => setStampPickerOpen(false)}
        onSelect={handleSendStamp}
      />

      <form onSubmit={handleSend} class="p-4 border-t border-neutral-900">
        <div class="flex gap-2">
          <button
            type="button"
            onClick={() => setStampPickerOpen((open) => !open)}
            disabled={sending()}
            aria-label={t("dm.stamps")}
            aria-expanded={stampPickerOpen()}
            class={`grid h-10 w-10 flex-shrink-0 place-items-center rounded-full border transition-colors disabled:opacity-50 ${
              stampPickerOpen()
                ? "border-accent bg-accent/15 text-accent"
                : "border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-white"
            }`}
          >
            <svg
              class="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="1.8"
                d="M7 3h7a5 5 0 015 5v7a6 6 0 01-6 6H7a4 4 0 01-4-4V7a4 4 0 014-4z"
              />
              <path
                stroke-linecap="round"
                stroke-width="1.8"
                d="M8 10h.01M14 10h.01M8.5 15c1.7 1.4 3.3 1.4 5 0"
              />
            </svg>
          </button>
          <input
            type="text"
            name="message"
            value={input()}
            onInput={handleInputChange}
            placeholder={t("dm.placeholder")}
            aria-label={t("dm.placeholder")}
            enterkeyhint="send"
            class="flex-1 px-4 py-2 bg-neutral-900 border border-neutral-800 rounded-full text-white placeholder-neutral-500 focus:outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={!input().trim() || sending()}
            aria-label={t("dm.send")}
            class="px-4 py-2 bg-accent disabled:bg-neutral-700 disabled:cursor-not-allowed text-white rounded-full font-medium transition-colors"
          >
            <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </form>

      <ConfirmSheet
        open={pendingDeleteMessage() !== null}
        title={t("confirm.deleteMessageTitle")}
        body={t("confirm.deletePostBody")}
        confirmLabel={t("common.delete")}
        destructive
        onConfirm={() => {
          const msg = pendingDeleteMessage();
          setPendingDeleteMessage(null);
          if (msg) void handleDeleteCommunityMessage(msg);
        }}
        onCancel={() => setPendingDeleteMessage(null)}
      />

      <StampPackSheet
        stamp={selectedStamp()}
        onClose={() => setSelectedStamp(null)}
      />
    </div>
  );
}
