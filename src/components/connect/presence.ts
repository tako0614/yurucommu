import { createSignal, onCleanup, onMount } from "solid-js";

// How many first-connection panels are mounted (the empty home shows one).
const [mounted, setMounted] = createSignal(0);

/** True while the empty home's first-connection panel is on screen. */
export const firstConnectionOnScreen = () => mounted() > 0;

/** Call from the first-connection panel so other surfaces avoid repeating it. */
export function markFirstConnectionOnScreen(): void {
  onMount(() => setMounted((n) => n + 1));
  onCleanup(() => setMounted((n) => Math.max(0, n - 1)));
}
