import {
  batch,
  createEffect,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { A } from "@solidjs/router";
import { Actor, DMMessage } from "../../types/index.ts";
import {
  CommunityMessage,
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
import { classifyWriteFailure } from "../../lib/write-outcome.ts";
import { createDMHistory, type DMHistoryToken } from "../../lib/dm-history.ts";
import { formatTime } from "../../lib/datetime.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { ConfirmSheet } from "../ConfirmSheet.tsx";
import { InlineErrorRetry } from "../InlineErrorRetry.tsx";
import { isComposingKey } from "../ime.ts";
import { UserAvatar } from "../UserAvatar.tsx";
import { markConversationOnScreen } from "../layout/routeChrome.ts";
import { formatMessageDay, messageDayKey } from "./message-day.ts";

interface DMChatPanelProps {
  contact: DMContact;
  actor: Actor;
  onBack: () => void;
  onRead?: () => void;
  onUserMessageSent?: () => void;
}

type ChatMessage = DMMessage | CommunityMessage;

// Poll interval for re-fetching incoming messages on the open conversation.
const MESSAGE_POLL_MS = 4000;

export function DMChatPanel(props: DMChatPanelProps) {
  markConversationOnScreen();
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [input, setInput] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [deletingMessage, setDeletingMessage] = createSignal<
    Record<string, boolean>
  >({});
  const [isTyping, setIsTyping] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
  const [historyError, setHistoryError] = createSignal<
    "initial" | "older" | null
  >(null);
  const [hasMoreOlder, setHasMoreOlder] = createSignal(false);
  const [loadingOlder, setLoadingOlder] = createSignal(false);
  const [retryingHistory, setRetryingHistory] = createSignal(false);
  let activation: DMHistoryToken | null = null;
  const history = createDMHistory<ChatMessage>((snapshot) => {
    batch(() => {
      setMessages(snapshot.messages);
      setLoading(snapshot.loading);
      setHasMoreOlder(snapshot.hasMore);
      setLoadingOlder(snapshot.loadingOlder);
      setHistoryError(snapshot.error);
    });
  });
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
  const [pendingDeleteMessage, setPendingDeleteMessage] = createSignal<{
    message: ChatMessage;
    token: DMHistoryToken;
  } | null>(null);
  const handleDeleteCommunityMessage = async (
    msg: ChatMessage,
    token: DMHistoryToken,
  ) => {
    if (
      !history.owns(token) ||
      props.contact.type !== "community" ||
      deletingMessage()[msg.id]
    )
      return;
    const contactApId = props.contact.ap_id;
    setDeletingMessage((prev) => ({ ...prev, [msg.id]: true }));
    try {
      await deleteCommunityMessage(contactApId, msg.id);
      history.remove(token, msg.id);
    } catch (e) {
      if (history.owns(token)) {
        console.error("Failed to delete message:", e);
        setErrorMessage(t("common.error"));
      }
    } finally {
      if (history.owns(token))
        setDeletingMessage((prev) => ({ ...prev, [msg.id]: false }));
    }
  };

  const refreshMessages = async (
    token: DMHistoryToken,
    contactApId: string,
    contactType: DMContact["type"],
    mode: "initial" | "poll",
  ) => {
    const result = await history.readNewest(token, mode, () =>
      contactType === "community"
        ? fetchCommunityMessages(contactApId)
        : fetchUserDMMessages(contactApId),
    );
    if (
      !history.owns(token) ||
      !result.applied ||
      (mode !== "initial" && !result.changed)
    )
      return;
    try {
      if (contactType === "community") await markCommunityAsRead(contactApId);
      else await markDMAsRead(contactApId);
      if (history.owns(token)) props.onRead?.();
    } catch {
      // Read marking does not change the accepted history.
    }
  };

  // The oldest canonical (published, apId) tuple owns the older-page cursor.
  const loadOlder = async () => {
    const token = activation;
    if (!token || !history.owns(token)) return;
    const contactApId = props.contact.ap_id;
    const contactType = props.contact.type;
    const el = scrollContainerRef;
    const prevHeight = el?.scrollHeight ?? 0;
    const applied = await history.readOlder(token, (cursor) =>
      contactType === "community"
        ? fetchCommunityMessages(contactApId, { before: cursor })
        : fetchUserDMMessages(contactApId, { before: cursor }),
    );
    if (!applied) return;
    queueMicrotask(() => {
      if (applied.isCurrent() && el && el === scrollContainerRef) {
        el.scrollTop += el.scrollHeight - prevHeight;
      }
    });
  };

  // Re-run the conversation's first read after it failed. The 4s poll cannot
  // clear that failure for an empty conversation (it ignores empty replies), so
  // without this the thread stays on the error until it is reopened.
  const retryHistory = async () => {
    const token = activation;
    if (!token || !history.owns(token) || retryingHistory()) return;
    setRetryingHistory(true);
    try {
      await refreshMessages(
        token,
        props.contact.ap_id,
        props.contact.type,
        "initial",
      );
    } finally {
      // A retry still in flight for the previous conversation must not
      // clear (or hold) this one's flag; the switch already reset it.
      if (activation === token) setRetryingHistory(false);
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
      () =>
        [props.contact.ap_id, props.contact.type, props.actor.ap_id] as const,
      ([contactApId, contactType]) => {
        const token = history.activate();
        activation = token;
        setRetryingHistory(false);
        setDeletingMessage({});
        setPendingDeleteMessage(null);
        setErrorMessage(null);

        // Reset scroll tracking so the new conversation jumps to its bottom once.
        prevLastId = null;
        prevCount = 0;
        didInitialScroll = false;
        void refreshMessages(token, contactApId, contactType, "initial");

        // Re-fetch incoming messages while the conversation is open so messages
        // sent by the other side appear without leaving and re-entering the thread.
        const intervalId = window.setInterval(() => {
          // Skip polling while the tab is backgrounded (wasted requests); the
          // contact-change / focus path refreshes when the user returns.
          if (document.hidden) return;
          void refreshMessages(token, contactApId, contactType, "poll");
        }, MESSAGE_POLL_MS);

        onCleanup(() => {
          history.invalidate(token);
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
    const token = activation;
    if (!text || sending() || !token || !history.owns(token)) return;

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
    const notifyUserMessageSent = props.onUserMessageSent;
    let userMessageSent = false;
    const stillOnConversation = () => history.owns(token);
    try {
      if (sentType === "community") {
        const newMsg = await sendCommunityMessage(sentApId, text);
        // Dedupe by id: a concurrent poll may have already merged this message.
        if (stillOnConversation()) {
          history.acknowledge(token, newMsg);
        }
      } else {
        const { message } = await sendUserDMMessage(sentApId, text);
        userMessageSent = true;
        if (stillOnConversation()) {
          history.acknowledge(token, message);
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
          classifyWriteFailure(e) === "unconfirmed"
            ? t("dm.sendUnconfirmed")
            : e instanceof ApiError && e.status === 403
              ? e.message
              : t("dm.sendRejected"),
        );
        // Retain rejected/unconfirmed drafts without overwriting text typed
        // during the request. An unconfirmed send may already be in history.
        setInput((cur) => (cur.trim() === "" ? text : cur));
      }
    } finally {
      setSending(false);
    }
    // Acceptance belongs to the acknowledged DM, even if its panel was closed
    // or another conversation is now visible. Parent cleanup fences its reads.
    // A UI refresh exception must never turn this successful send into a
    // rejected/unconfirmed send or restore the sent draft.
    if (userMessageSent) {
      try {
        notifyUserMessageSent?.();
      } catch (e) {
        console.error("Failed to refresh DM requests after sending:", e);
      }
    }
  };

  const handleInputChange = (
    e: InputEvent & { currentTarget: HTMLTextAreaElement },
  ) => {
    const value = e.currentTarget.value;
    setInput(value);
    void sendTyping(value);
  };

  // The composer is a textarea so a message can have line breaks. It grows
  // with its text up to five lines, then scrolls. With a keyboard, Enter sends
  // and Shift+Enter starts a line; on a touch screen the return key starts a
  // line and the send button sends (as in other messaging apps). Ctrl/Cmd+
  // Enter always sends (an iPad with a keyboard reports a coarse pointer).
  // The Enter that confirms an IME conversion never sends.
  let composerRef: HTMLTextAreaElement | undefined;
  const COMPOSER_MAX_PX = 5 * 24 + 16 + 2; // 5 lines + py-2 + border
  const coarsePointer = () =>
    typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  createEffect(() => {
    input();
    const el = composerRef;
    if (!el) return;
    // Keep the newest messages in view when the composer grows under them.
    const log = scrollContainerRef;
    const pinned =
      !!log && log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    el.style.height = "auto";
    // scrollHeight leaves out the border; without it the box always scrolled.
    const border = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + border, COMPOSER_MAX_PX)}px`;
    if (pinned && log) log.scrollTop = log.scrollHeight;
  });
  const handleComposerKeyDown = (
    e: KeyboardEvent & { currentTarget: HTMLTextAreaElement },
  ) => {
    if (e.key !== "Enter" || e.shiftKey || isComposingKey(e)) return;
    if (coarsePointer() && !e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  };

  const getSenderApId = (msg: DMMessage | CommunityMessage): string => {
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
              // A failed first read is not an empty conversation: say so and
              // offer the read again instead of inviting a first message.
              <Show
                when={historyError() === "initial"}
                fallback={
                  <div class="text-center text-neutral-500">
                    {props.contact.type === "community"
                      ? t("communityChat.noMessages")
                      : t("dm.noMessages")}
                  </div>
                }
              >
                <InlineErrorRetry
                  message={t("common.loadFailed")}
                  retryLabel={
                    retryingHistory() ? t("common.loading") : t("common.retry")
                  }
                  onRetry={() => void retryHistory()}
                />
              </Show>
            }
          >
            <Show when={hasMoreOlder()}>
              <div class="flex flex-col items-center gap-2 pb-3">
                {/* Plain text: additions to the log are announced already. */}
                <Show when={historyError() === "older"}>
                  <p class="text-sm text-red-400">{t("common.loadFailed")}</p>
                </Show>
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
                // Times alone read as one sitting; a divider marks each day.
                const startsDay = () =>
                  index() === 0 ||
                  messageDayKey(messages()[index() - 1].created_at) !==
                    messageDayKey(msg.created_at);
                const showAvatar = () =>
                  !isMine() &&
                  (startsDay() ||
                    getSenderApId(messages()[index() - 1]) !==
                      getSenderApId(msg));

                const dayLabel = () =>
                  formatMessageDay(msg.created_at, language());

                return (
                  <>
                    <Show when={startsDay() && dayLabel()}>
                      <div class="my-3 flex justify-center">
                        <span class="rounded-full bg-neutral-800 px-3 py-1 text-xs text-neutral-400">
                          {dayLabel()}
                        </span>
                      </div>
                    </Show>
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
                        <div class="text-xs text-neutral-500 mt-1">
                          {formatTime(msg.created_at, language())}
                          <Show
                            when={
                              isMine() && props.contact.type === "community"
                            }
                          >
                            <button
                              type="button"
                              onClick={() => {
                                if (activation)
                                  setPendingDeleteMessage({
                                    message: msg,
                                    token: activation,
                                  });
                              }}
                              disabled={deletingMessage()[msg.id]}
                              class="ml-2 text-rose-400 hover:text-rose-300 disabled:opacity-50"
                            >
                              {t("common.delete")}
                            </button>
                          </Show>
                        </div>
                      </div>
                    </div>
                  </>
                );
              }}
            </For>
          </Show>
        </Show>
        <Show when={props.contact.type === "user" && isTyping()}>
          <div class="text-xs text-neutral-500 mt-2">{t("dm.typing")}</div>
        </Show>
        <div ref={messagesEndRef!} />
      </div>

      <form onSubmit={handleSend} class="p-4 border-t border-neutral-900">
        <Show when={errorMessage()}>
          <div
            role="alert"
            class="mb-3 text-center text-red-400 text-sm break-words"
          >
            {errorMessage()}
          </div>
        </Show>
        <div class="flex items-end gap-2">
          <textarea
            ref={composerRef}
            rows={1}
            value={input()}
            onInput={handleInputChange}
            onKeyDown={handleComposerKeyDown}
            placeholder={t("dm.placeholder")}
            aria-label={t("dm.placeholder")}
            enterkeyhint={coarsePointer() ? "enter" : "send"}
            class="flex-1 min-w-0 resize-none overflow-y-auto px-4 py-2 leading-6 bg-neutral-900 border border-neutral-800 rounded-3xl text-white placeholder-neutral-500 focus:outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={!input().trim() || sending()}
            aria-label={t("dm.send")}
            class="h-10 shrink-0 px-4 py-2 bg-accent disabled:bg-neutral-700 disabled:cursor-not-allowed text-white rounded-full font-medium transition-colors"
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
          const pending = pendingDeleteMessage();
          setPendingDeleteMessage(null);
          if (pending)
            void handleDeleteCommunityMessage(pending.message, pending.token);
        }}
        onCancel={() => setPendingDeleteMessage(null)}
      />
    </div>
  );
}
