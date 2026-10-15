import { For, Show } from "solid-js";
import { useI18n } from "../lib/i18n.tsx";

/**
 * Japanese has no spaces, so a narrow label or heading breaks wherever the
 * line fills up ("あなたのス / トーリー"). This renders a UI string with line
 * breaks offered only between words; pair it with `break-keep` (so the browser
 * adds none of its own) and `wrap-anywhere` (so a single word that cannot fit
 * still wraps). Use it for fixed UI copy only: word segmentation of names is
 * unreliable ("はなこ" splits as "はな" + "こ").
 *
 * The words become separate text nodes. Inside a heading or a named control
 * that is harmless; a standalone label should keep its read-aloud text whole
 * (aria-hidden on this, plus an sr-only copy).
 */
export function WordBreakText(props: { text: string }) {
  const { language } = useI18n();
  const words = () => {
    if (typeof Intl === "undefined" || !("Segmenter" in Intl)) {
      return [props.text];
    }
    const segmenter = new Intl.Segmenter(language(), { granularity: "word" });
    return Array.from(segmenter.segment(props.text), (part) => part.segment);
  };
  return (
    <For each={words()}>
      {(word, index) => (
        <>
          <Show when={index() > 0}>
            <wbr />
          </Show>
          {word}
        </>
      )}
    </For>
  );
}
