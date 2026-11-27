import { createSignal, onCleanup } from "solid-js";

/**
 * Tracks whether a horizontally scrollable container (such as mobile filter
 * tabs) currently overflows to the left or right, so subtle gradient edge
 * fades can signal scrollability without cluttering desktop views.
 */
export function createHorizontalScrollFade() {
  const [canScrollLeft, setCanScrollLeft] = createSignal(false);
  const [canScrollRight, setCanScrollRight] = createSignal(false);

  const measure = (el: HTMLElement) => {
    const maxScroll = el.scrollWidth - el.clientWidth;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(maxScroll - el.scrollLeft > 2);
  };

  let attached: HTMLElement | null = null;
  let observer: ResizeObserver | null = null;
  const onScroll = () => {
    if (attached) measure(attached);
  };

  const cleanup = () => {
    if (attached) {
      attached.removeEventListener("scroll", onScroll);
      attached = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  };

  onCleanup(cleanup);

  const bind = (el: HTMLElement) => {
    cleanup();
    attached = el;
    el.addEventListener("scroll", onScroll, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => measure(el));
      observer.observe(el);
    }
    queueMicrotask(() => {
      if (attached === el) measure(el);
    });
  };

  return { canScrollLeft, canScrollRight, bind };
}
