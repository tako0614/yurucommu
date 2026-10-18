/**
 * Keyboard for a grid of colour or gradient swatches that pick one value: the
 * grid is a radio group with a single Tab stop (the checked swatch, else the
 * first), and ← → ↑ ↓ Home End move and pick, as radio buttons do. Each swatch
 * was its own Tab stop: 16 colours for drawing, and up to 29 in the background
 * panel.
 */

/** The Tab stop: the checked swatch, or the first when none is checked. */
export function swatchTabIndex(
  checked: boolean,
  index: number,
  anyChecked: boolean,
): number {
  return checked || (!anyChecked && index === 0) ? 0 : -1;
}

export function onSwatchKeyDown(
  e: KeyboardEvent & { currentTarget: HTMLElement },
) {
  // Arrow keys with a modifier stay the browser's (Alt+← is Back).
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const radios = [
    ...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'),
  ];
  const at = radios.indexOf(e.target as HTMLElement);
  if (at === -1) return;
  // Columns from the layout rather than a number passed in, so the grid's
  // classes stay the only place that says how many there are.
  const top = radios[0].offsetTop;
  const firstRowEnd = radios.findIndex((radio) => radio.offsetTop !== top);
  const columns = firstRowEnd === -1 ? radios.length : firstRowEnd;
  const last = radios.length - 1;
  const next =
    e.key === "ArrowRight"
      ? at === last
        ? 0
        : at + 1
      : e.key === "ArrowLeft"
        ? at === 0
          ? last
          : at - 1
        : // At the top or bottom row ↑ / ↓ stay put: clamping picked a
          // different swatch (from the bottom row, the last one).
          e.key === "ArrowDown"
          ? at + columns <= last
            ? at + columns
            : at
          : e.key === "ArrowUp"
            ? at - columns >= 0
              ? at - columns
              : at
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? last
                : null;
  if (next === null) return;
  e.preventDefault();
  if (next === at) return;
  radios[next].focus();
  // A radio is checked as focus moves to it.
  radios[next].click();
}
