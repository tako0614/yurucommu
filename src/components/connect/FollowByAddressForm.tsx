import { createSignal, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { useI18n } from "../../lib/i18n.tsx";
import { toFollowSearchQuery } from "../first-feed-address.ts";

const SearchIcon = () => (
  <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width={2}
      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
    />
  </svg>
);

/**
 * "Find someone to follow" by address. It hands the normalized query to the
 * search page, which runs a local search first and, for an address it cannot
 * find here, offers to look on other servers; that remote lookup stays the
 * owner's explicit choice.
 */
export function FollowByAddressForm(props: {
  /** Unique id for the input; the hint uses `${id}-hint`. */
  id: string;
  /** Narrow placement (the desktop right column). */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [query, setQuery] = createSignal("");
  let input!: HTMLInputElement;

  const findPerson = (event: SubmitEvent) => {
    event.preventDefault();
    const search = toFollowSearchQuery(query());
    if (!search) {
      input.focus();
      return;
    }
    navigate(`/search?search=${encodeURIComponent(search)}`);
  };

  return (
    <form role="search" onSubmit={findPerson}>
      <label for={props.id} class="block text-sm font-medium text-neutral-200">
        {t("firstFeed.findPeople")}
      </label>
      {/* The right column is too narrow for the example address next to the
          button, so the compact form stacks them. */}
      <div
        class={props.compact ? "mt-2 flex flex-col gap-2" : "mt-2 flex gap-2"}
      >
        <input
          ref={input}
          id={props.id}
          type="text"
          inputmode="email"
          autocomplete="off"
          autocapitalize="none"
          spellcheck={false}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          placeholder={t("firstFeed.addressPlaceholder")}
          aria-describedby={`${props.id}-hint`}
          class={`min-w-0 flex-1 rounded-full border border-neutral-700 bg-neutral-900 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--accent)] ${
            props.compact ? "px-4" : "px-3 sm:px-4"
          }`}
        />
        <button
          type="submit"
          class={`flex shrink-0 items-center gap-2 rounded-full bg-accent py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] ${
            props.compact ? "self-end px-5" : "px-5"
          }`}
        >
          <Show when={!props.compact}>
            <span class="hidden sm:inline-flex">
              <SearchIcon />
            </span>
          </Show>
          {t("firstFeed.search")}
        </button>
      </div>
      <p
        id={`${props.id}-hint`}
        class="mt-2 text-xs leading-relaxed text-neutral-400 [line-break:strict]"
      >
        {t("firstFeed.addressHint")}
      </p>
    </form>
  );
}
