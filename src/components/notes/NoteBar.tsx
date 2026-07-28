import { createSignal, For, type JSX, Show } from "solid-js";
import type { Actor, ActorNote } from "../../types/index.ts";
import { useI18n } from "../../lib/i18n.tsx";
import { useDialog } from "../../lib/useDialog.ts";
import { UserAvatar } from "../UserAvatar.tsx";

interface NoteBarProps {
  actor: Actor;
  notes: ActorNote[];
  loading?: boolean;
  error?: string | null;
  saving?: boolean;
  onRetry?: () => void;
  onSave: (content: string) => Promise<boolean> | boolean;
  onDelete: () => Promise<boolean> | boolean;
}

const MAX_NOTE_LENGTH = 80;

const PlusIcon = () => (
  <svg
    class="h-3.5 w-3.5"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={2}
      d="M12 4v16m8-8H4"
    />
  </svg>
);

function NoteTile(props: {
  avatarUrl?: string | null;
  name: string;
  content: string;
  onClick?: () => void;
  add?: boolean;
}) {
  const tileClass = "group flex w-20 shrink-0 flex-col items-center";
  const body = (): JSX.Element => (
    <>
      <div class="relative mb-1 flex h-9 w-full items-end justify-center">
        <div
          class={`relative max-w-[76px] rounded-2xl border px-2 py-1 text-center shadow-sm transition-colors ${
            props.add
              ? "border-neutral-700 bg-neutral-800 text-neutral-300 group-hover:border-neutral-600 group-hover:bg-neutral-700 group-hover:text-white"
              : "border-neutral-800 bg-neutral-900 text-white group-hover:border-neutral-700 group-hover:bg-neutral-800"
          }`}
        >
          <p class="line-clamp-2 text-[11px] leading-tight">{props.content}</p>
          <span
            class={`absolute -bottom-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-b border-r ${
              props.add
                ? "border-neutral-700 bg-neutral-800 group-hover:border-neutral-600 group-hover:bg-neutral-700"
                : "border-neutral-800 bg-neutral-900 group-hover:border-neutral-700 group-hover:bg-neutral-800"
            }`}
            aria-hidden="true"
          />
        </div>
      </div>
      <div class="relative">
        <UserAvatar
          avatarUrl={props.avatarUrl ?? null}
          name={props.name}
          size={44}
        />
        <Show when={props.add}>
          <div class="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white ring-2 ring-neutral-900">
            <PlusIcon />
          </div>
        </Show>
      </div>
      <span class="mt-1 max-w-full truncate text-xs text-neutral-500 group-hover:text-neutral-300">
        {props.name}
      </span>
    </>
  );
  // Tiles without an action (other users' notes) render as a plain div — a
  // focusable <button> that does nothing on activation is a keyboard/SR trap.
  return (
    <Show when={props.onClick} fallback={<div class={tileClass}>{body()}</div>}>
      <button type="button" onClick={props.onClick} class={tileClass}>
        {body()}
      </button>
    </Show>
  );
}

export function NoteBar(props: NoteBarProps) {
  const { t } = useI18n();
  const [editorOpen, setEditorOpen] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  let editorRef: HTMLFormElement | undefined;
  // Shared modal-dialog primitive: Escape closes, Tab is trapped, background
  // scroll locks, and focus is restored to the opener tile on close (the
  // editor previously had role=dialog but none of the behaviour).
  useDialog({
    isOpen: editorOpen,
    onClose: () => setEditorOpen(false),
    container: () => editorRef,
  });

  const myNote = () => props.notes.find((note) => note.is_mine);
  const otherNotes = () => props.notes.filter((note) => !note.is_mine);
  const canSave = () =>
    draft().trim().length > 0 &&
    draft().trim().length <= MAX_NOTE_LENGTH &&
    !props.saving;

  const openEditor = () => {
    setDraft(myNote()?.content ?? "");
    setEditorOpen(true);
  };

  const save = async () => {
    if (!canSave()) return;
    const ok = await props.onSave(draft());
    if (ok) setEditorOpen(false);
  };

  const remove = async () => {
    const ok = await props.onDelete();
    if (ok) setEditorOpen(false);
  };

  return (
    <>
      <Show
        when={!props.loading}
        fallback={
          <div class="border-b border-neutral-900 px-4 py-3">
            <div class="flex gap-3 overflow-x-hidden">
              <div class="h-24 w-20 shrink-0 rounded-2xl bg-neutral-800/80 animate-pulse" />
              <div class="h-24 w-20 shrink-0 rounded-2xl bg-neutral-800/60 animate-pulse" />
              <div class="h-24 w-20 shrink-0 rounded-2xl bg-neutral-800/50 animate-pulse" />
            </div>
          </div>
        }
      >
        <div class="border-b border-neutral-900 px-4 py-3">
          <div class="flex gap-3 overflow-x-auto scrollbar-hide">
            <NoteTile
              onClick={openEditor}
              avatarUrl={props.actor.icon_url}
              name={props.actor.name || props.actor.username}
              content={myNote()?.content ?? t("notes.add")}
              add={!myNote()}
            />

            <Show
              when={!props.error}
              fallback={
                <div class="flex min-w-0 items-center gap-2 text-xs text-neutral-400">
                  <span class="line-clamp-2">{props.error}</span>
                  <Show when={props.onRetry}>
                    <button
                      type="button"
                      onClick={() => props.onRetry?.()}
                      class="shrink-0 text-accent hover:underline"
                    >
                      {t("common.retry")}
                    </button>
                  </Show>
                </div>
              }
            >
              <For each={otherNotes()}>
                {(note) => (
                  <NoteTile
                    avatarUrl={note.actor.icon_url}
                    name={note.actor.name || note.actor.preferred_username}
                    content={note.content}
                  />
                )}
              </For>
            </Show>
          </div>
        </div>
      </Show>

      <Show when={editorOpen()}>
        <div
          class="fixed inset-0 z-50 flex items-end justify-center bg-black/60 px-3 pb-3 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-label={t("notes.title")}
        >
          <button
            type="button"
            class="absolute inset-0 cursor-default"
            aria-label={t("common.close")}
            onClick={() => setEditorOpen(false)}
          />
          <form
            ref={editorRef}
            class="relative w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-950 p-4 shadow-2xl"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div class="mb-3 flex items-center justify-between gap-3">
              <h2 class="text-base font-semibold text-white">
                {t("notes.title")}
              </h2>
              <button
                type="button"
                onClick={() => setEditorOpen(false)}
                class="rounded-full p-2 text-neutral-400 transition-colors hover:bg-neutral-900 hover:text-white"
                aria-label={t("common.close")}
              >
                <svg
                  class="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <textarea
              value={draft()}
              maxLength={MAX_NOTE_LENGTH}
              onInput={(event) => setDraft(event.currentTarget.value)}
              placeholder={t("notes.placeholder")}
              class="h-28 w-full resize-none rounded-xl border border-neutral-800 bg-neutral-900 px-3 py-3 text-sm leading-relaxed text-white outline-none transition-colors placeholder:text-neutral-600 focus:border-neutral-600"
              autofocus
            />
            <div class="mt-2 flex items-center justify-between gap-3">
              <span class="text-xs text-neutral-500">
                {t("notes.charCount")
                  .replace("{count}", String(draft().trim().length))
                  .replace("{max}", String(MAX_NOTE_LENGTH))}
              </span>
              <div class="flex items-center gap-2">
                <Show when={myNote()}>
                  <button
                    type="button"
                    onClick={() => void remove()}
                    disabled={props.saving}
                    class="rounded-full px-3 py-1.5 text-sm text-neutral-400 transition-colors hover:bg-neutral-900 hover:text-white disabled:opacity-50"
                  >
                    {t("common.delete")}
                  </button>
                </Show>
                <button
                  type="submit"
                  disabled={!canSave()}
                  class="rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-black transition-opacity disabled:opacity-40"
                >
                  {props.saving ? t("common.saving") : t("common.save")}
                </button>
              </div>
            </div>
          </form>
        </div>
      </Show>
    </>
  );
}
