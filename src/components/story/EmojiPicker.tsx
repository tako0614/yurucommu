/**
 * Emoji Picker Component
 *
 * Simple emoji picker organized by categories.
 */

import { createSignal, createUniqueId, For } from "solid-js";
import { useI18n } from "../../lib/i18n.tsx";
import type { TranslationKey } from "../../lib/i18n.tsx";

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
}

// Emoji categories
const EMOJI_CATEGORIES = [
  {
    name: "story.emojiFaces",
    emojis: [
      "😀",
      "😃",
      "😄",
      "😁",
      "😆",
      "😅",
      "🤣",
      "😂",
      "🙂",
      "😉",
      "😊",
      "😇",
      "🥰",
      "😍",
      "🤩",
      "😘",
      "😗",
      "😚",
      "😋",
      "😛",
      "😜",
      "🤪",
      "😝",
      "🤑",
      "🤗",
      "🤭",
      "🤫",
      "🤔",
      "🤐",
      "🤨",
      "😐",
      "😑",
      "😶",
      "😏",
      "😒",
      "🙄",
      "😬",
      "🤥",
      "😌",
      "😔",
      "😪",
      "🤤",
      "😴",
      "😷",
      "🤒",
      "🤕",
      "🤢",
      "🤮",
      "🤧",
      "🥵",
      "🥶",
      "🥴",
      "😵",
      "🤯",
      "🤠",
      "🥳",
      "😎",
      "🤓",
      "🧐",
      "😕",
      "😟",
      "🙁",
      "😮",
      "😯",
      "😲",
      "😳",
      "🥺",
      "😦",
      "😧",
      "😨",
      "😰",
      "😥",
      "😢",
      "😭",
      "😱",
      "😖",
      "😣",
      "😞",
      "😓",
      "😩",
      "😫",
      "🥱",
      "😤",
      "😡",
      "😠",
      "🤬",
      "😈",
      "👿",
      "💀",
      "☠️",
      "💩",
      "🤡",
      "👹",
      "👺",
      "👻",
      "👽",
    ],
  },
  {
    name: "story.emojiGestures",
    emojis: [
      "👋",
      "🤚",
      "🖐️",
      "✋",
      "🖖",
      "👌",
      "🤌",
      "🤏",
      "✌️",
      "🤞",
      "🤟",
      "🤘",
      "🤙",
      "👈",
      "👉",
      "👆",
      "🖕",
      "👇",
      "☝️",
      "👍",
      "👎",
      "✊",
      "👊",
      "🤛",
      "🤜",
      "👏",
      "🙌",
      "👐",
      "🤲",
      "🤝",
      "🙏",
      "✍️",
      "💪",
      "🦾",
      "🦿",
      "🦵",
      "🦶",
      "👂",
      "🦻",
      "👃",
      "👀",
      "👁️",
      "👅",
      "👄",
      "💋",
      "🧠",
      "🫀",
      "🫁",
    ],
  },
  {
    name: "story.emojiHearts",
    emojis: [
      "❤️",
      "🧡",
      "💛",
      "💚",
      "💙",
      "💜",
      "🖤",
      "🤍",
      "🤎",
      "💔",
      "❣️",
      "💕",
      "💞",
      "💓",
      "💗",
      "💖",
      "💘",
      "💝",
      "💟",
      "♥️",
      "🫶",
      "💑",
      "💏",
      "👨‍❤️‍👨",
    ],
  },
  {
    name: "story.emojiAnimals",
    emojis: [
      "🐶",
      "🐱",
      "🐭",
      "🐹",
      "🐰",
      "🦊",
      "🐻",
      "🐼",
      "🐻‍❄️",
      "🐨",
      "🐯",
      "🦁",
      "🐮",
      "🐷",
      "🐸",
      "🐵",
      "🙈",
      "🙉",
      "🙊",
      "🐒",
      "🐔",
      "🐧",
      "🐦",
      "🐤",
      "🦆",
      "🦅",
      "🦉",
      "🦇",
      "🐺",
      "🐗",
      "🐴",
      "🦄",
      "🐝",
      "🪱",
      "🐛",
      "🦋",
      "🐌",
      "🐞",
      "🐜",
      "🪲",
      "🐢",
      "🐍",
      "🦎",
      "🦖",
      "🦕",
      "🐙",
      "🦑",
      "🦐",
      "🦞",
      "🦀",
      "🐡",
      "🐠",
      "🐟",
      "🐬",
      "🐳",
      "🐋",
      "🦈",
      "🐊",
      "🐅",
      "🐆",
      "🦓",
      "🦍",
      "🦧",
      "🐘",
    ],
  },
  {
    name: "story.emojiFood",
    emojis: [
      "🍎",
      "🍐",
      "🍊",
      "🍋",
      "🍌",
      "🍉",
      "🍇",
      "🍓",
      "🫐",
      "🍈",
      "🍒",
      "🍑",
      "🥭",
      "🍍",
      "🥥",
      "🥝",
      "🍅",
      "🍆",
      "🥑",
      "🥦",
      "🥬",
      "🥒",
      "🌶️",
      "🫑",
      "🌽",
      "🥕",
      "🫒",
      "🧄",
      "🧅",
      "🥔",
      "🍠",
      "🥐",
      "🥯",
      "🍞",
      "🥖",
      "🥨",
      "🧀",
      "🥚",
      "🍳",
      "🧈",
      "🥞",
      "🧇",
      "🥓",
      "🥩",
      "🍗",
      "🍖",
      "🦴",
      "🌭",
      "🍔",
      "🍟",
      "🍕",
      "🫓",
      "🥪",
      "🥙",
      "🧆",
      "🌮",
      "🌯",
      "🫔",
      "🥗",
      "🥘",
      "🫕",
      "🍝",
      "🍜",
      "🍲",
      "🍛",
      "🍣",
      "🍱",
      "🥟",
      "🦪",
      "🍤",
      "🍙",
      "🍚",
      "🍘",
      "🍥",
      "🥠",
      "🥮",
      "🍢",
      "🍡",
      "🍧",
      "🍨",
      "🍦",
      "🥧",
      "🧁",
      "🍰",
      "🎂",
      "🍮",
      "🍭",
      "🍬",
      "🍫",
      "🍿",
      "🍩",
      "🍪",
      "🌰",
      "🥜",
      "🍯",
      "🥛",
      "🍼",
      "☕",
      "🫖",
      "🍵",
      "🧃",
      "🥤",
      "🧋",
      "🍶",
      "🍺",
      "🍻",
      "🥂",
      "🍷",
      "🥃",
      "🍸",
      "🍹",
      "🧉",
    ],
  },
  {
    name: "story.emojiNature",
    emojis: [
      "🌸",
      "💮",
      "🏵️",
      "🌹",
      "🥀",
      "🌺",
      "🌻",
      "🌼",
      "🌷",
      "🌱",
      "🪴",
      "🌲",
      "🌳",
      "🌴",
      "🌵",
      "🌾",
      "🌿",
      "☘️",
      "🍀",
      "🍁",
      "🍂",
      "🍃",
      "🪹",
      "🪺",
      "🍄",
      "🌰",
      "🦀",
      "🌍",
      "🌎",
      "🌏",
      "🌐",
      "🪨",
      "🌑",
      "🌒",
      "🌓",
      "🌔",
      "🌕",
      "🌖",
      "🌗",
      "🌘",
      "🌙",
      "🌚",
      "🌛",
      "🌜",
      "☀️",
      "🌝",
      "🌞",
      "⭐",
      "🌟",
      "🌠",
      "☁️",
      "⛅",
      "⛈️",
      "🌤️",
      "🌥️",
      "🌦️",
      "🌧️",
      "🌨️",
      "🌩️",
      "🌪️",
      "🌫️",
      "🌬️",
      "🌀",
      "🌈",
      "☔",
      "⚡",
      "❄️",
      "☃️",
      "⛄",
      "🔥",
      "💧",
      "🌊",
    ],
  },
  {
    name: "story.emojiSymbols",
    emojis: [
      "⭐",
      "✨",
      "💫",
      "🌟",
      "⚡",
      "🔥",
      "💥",
      "💢",
      "💦",
      "💨",
      "🕳️",
      "💣",
      "💬",
      "👁️‍🗨️",
      "🗨️",
      "🗯️",
      "💭",
      "💤",
      "🎵",
      "🎶",
      "🎼",
      "🎧",
      "📢",
      "📣",
      "🔔",
      "🔕",
      "🎤",
      "🎬",
      "🎥",
      "📷",
      "📸",
      "📹",
      "📼",
      "🔍",
      "🔎",
      "💡",
      "🔦",
      "🏮",
      "📖",
      "📚",
      "✏️",
      "📝",
      "📌",
      "📍",
      "📎",
      "🔒",
      "🔓",
      "🔑",
      "🗝️",
      "🔨",
      "⚙️",
      "🔧",
      "🔩",
      "⛏️",
      "🛠️",
      "🗡️",
      "💉",
      "💊",
      "🩹",
      "🩺",
      "🔬",
      "🔭",
      "📡",
      "🛎️",
      "🚪",
      "🛏️",
      "🛋️",
      "🪑",
      "🚽",
      "🚿",
      "🛁",
      "🪒",
      "🧴",
      "🧷",
      "🧹",
      "🧺",
      "🧻",
      "🪣",
      "🧼",
      "🪥",
      "⚠️",
      "🚸",
      "⛔",
      "🚫",
      "🚳",
      "🚭",
      "🚯",
      "🚱",
      "🔞",
      "☢️",
      "☣️",
      "⬆️",
      "↗️",
      "➡️",
      "↘️",
      "⬇️",
      "↙️",
      "⬅️",
      "↖️",
      "↕️",
      "↔️",
      "↩️",
      "↪️",
      "⤴️",
      "⤵️",
      "🔃",
      "🔄",
      "🔙",
      "🔚",
      "🔛",
      "🔜",
      "🔝",
      "✅",
      "☑️",
      "✔️",
      "❌",
      "❎",
      "➕",
      "➖",
      "➗",
      "✖️",
      "💲",
      "💱",
      "©️",
      "®️",
      "™️",
      "#️⃣",
      "*️⃣",
      "0️⃣",
      "1️⃣",
      "2️⃣",
      "3️⃣",
      "4️⃣",
      "5️⃣",
      "6️⃣",
      "7️⃣",
      "8️⃣",
      "9️⃣",
      "🔟",
      "💯",
      "🔠",
      "🔡",
      "🔢",
      "🔣",
      "🔤",
      "🆎",
      "🆑",
      "🆒",
      "🆓",
      "🆔",
      "🆕",
      "🆖",
      "🆗",
      "🆘",
      "🆙",
      "🆚",
      "🈁",
      "🈂️",
      "🈷️",
      "🈶",
      "🈯",
      "🉐",
      "🈹",
      "🈚",
      "🈲",
      "🉑",
      "🈸",
      "🈴",
      "🈳",
      "㊗️",
      "㊙️",
      "🈺",
      "🈵",
      "🔴",
      "🟠",
      "🟡",
      "🟢",
      "🔵",
      "🟣",
      "🟤",
      "⚫",
      "⚪",
      "🟥",
      "🟧",
      "🟨",
      "🟩",
      "🟦",
      "🟪",
      "🟫",
      "⬛",
      "⬜",
      "◼️",
      "◻️",
      "◾",
      "◽",
      "▪️",
      "▫️",
      "🔶",
      "🔷",
      "🔸",
      "🔹",
      "🔺",
      "🔻",
      "💠",
      "🔘",
      "🔳",
      "🔲",
      "🏁",
    ],
  },
];

// One Tab stop for the categories and one for the emoji, with the arrow keys
// inside each (tabs: ← → Home End; emoji: ← → ↑ ↓ Home End). Every one of the
// ~100 emoji was a Tab stop, so getting past an open picker to 投稿 took over
// a hundred presses.
export function EmojiPicker(props: EmojiPickerProps) {
  const { t } = useI18n();
  const id = createUniqueId();
  const [activeCategory, setActiveCategory] = createSignal(0);
  // The emoji that holds the grid's Tab stop: the last one focused.
  const [current, setCurrent] = createSignal(0);
  let tabsRef: HTMLDivElement | undefined;
  let gridRef: HTMLDivElement | undefined;
  let scrollRef: HTMLDivElement | undefined;

  const emojiButtons = () =>
    gridRef ? [...gridRef.querySelectorAll<HTMLElement>("button")] : [];

  const tabs = () =>
    tabsRef ? [...tabsRef.querySelectorAll<HTMLElement>("[role=tab]")] : [];

  const selectCategory = (index: number, focusTab: boolean) => {
    // A click that does not move focus (Safari) left it on an emoji that the
    // new category's list replaces: it goes to the tab instead of <body>.
    const fromGrid = !!gridRef?.contains(document.activeElement);
    setActiveCategory(index);
    setCurrent(0);
    scrollRef?.scrollTo({ top: 0 });
    if (focusTab || fromGrid) tabs()[index]?.focus();
  };

  // Arrow keys with a modifier stay the browser's (Alt+← is Back).
  const modified = (e: KeyboardEvent) => e.altKey || e.ctrlKey || e.metaKey;

  const onTabsKeyDown = (e: KeyboardEvent) => {
    if (modified(e)) return;
    const count = EMOJI_CATEGORIES.length;
    // From the focused tab, which a screen reader can move off the selected one.
    const focused = tabs().indexOf(e.target as HTMLElement);
    const at = focused === -1 ? activeCategory() : focused;
    const next =
      e.key === "ArrowRight"
        ? (at + 1) % count
        : e.key === "ArrowLeft"
          ? (at - 1 + count) % count
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? count - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    selectCategory(next, true);
  };

  // The grid fits as many columns as the width allows, so a row is counted
  // from the layout rather than fixed.
  const columns = (buttons: HTMLElement[]) => {
    const top = buttons[0]?.offsetTop;
    const firstRow = buttons.findIndex((button) => button.offsetTop !== top);
    return firstRow === -1 ? buttons.length : Math.max(1, firstRow);
  };

  const onGridKeyDown = (e: KeyboardEvent) => {
    if (modified(e)) return;
    const buttons = emojiButtons();
    if (buttons.length === 0) return;
    const last = buttons.length - 1;
    const at = current();
    const step = columns(buttons);
    const next =
      e.key === "ArrowRight"
        ? Math.min(last, at + 1)
        : e.key === "ArrowLeft"
          ? Math.max(0, at - 1)
          : e.key === "ArrowDown"
            ? at + step <= last
              ? at + step
              : at
            : e.key === "ArrowUp"
              ? at - step >= 0
                ? at - step
                : at
              : e.key === "Home"
                ? 0
                : e.key === "End"
                  ? last
                  : null;
    if (next === null) return;
    e.preventDefault();
    setCurrent(next);
    buttons[next]?.focus();
  };

  return (
    <div class="space-y-2">
      {/* Category tabs */}
      <div
        ref={tabsRef}
        role="tablist"
        // Scroll containers are Tab stops in Firefox; this one and the grid's
        // made the picker four stops there instead of two.
        tabIndex={-1}
        onKeyDown={onTabsKeyDown}
        class="flex gap-1 overflow-x-auto pb-2 scrollbar-thin"
      >
        <For each={EMOJI_CATEGORIES}>
          {(category, index) => (
            <button
              type="button"
              role="tab"
              id={`${id}-tab-${index()}`}
              aria-selected={activeCategory() === index()}
              aria-controls={`${id}-panel`}
              tabIndex={activeCategory() === index() ? 0 : -1}
              onClick={() => selectCategory(index(), false)}
              class={`px-3 py-1.5 rounded-full text-sm whitespace-nowrap transition-colors ${
                activeCategory() === index()
                  ? "bg-accent text-white"
                  : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
              }`}
            >
              {t(category.name as TranslationKey)}
            </button>
          )}
        </For>
      </div>

      {/* Emoji grid */}
      <div
        ref={scrollRef}
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${activeCategory()}`}
        tabIndex={-1}
        class="h-48 overflow-y-auto"
      >
        {/* As many 36px columns as fit: eight fixed ones were 316px wide
            and cut off the last column in a 320px phone's composer. */}
        <div
          ref={gridRef}
          onKeyDown={onGridKeyDown}
          class="grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1"
        >
          <For each={EMOJI_CATEGORIES[activeCategory()].emojis}>
            {(emoji, index) => (
              <button
                type="button"
                tabIndex={current() === index() ? 0 : -1}
                onFocus={() => setCurrent(index())}
                onClick={() => props.onSelect(emoji)}
                class="h-9 w-full flex items-center justify-center text-2xl hover:bg-neutral-800 rounded-lg transition-colors"
              >
                {emoji}
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

export default EmojiPicker;
