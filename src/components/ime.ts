/**
 * True for a key pressed while an IME (Japanese, Chinese, Korean input) is
 * composing. The Enter that confirms a conversion must not also send or add:
 * Chrome and Firefox mark it with `isComposing`, Safari only with keyCode 229.
 */
export function isComposingKey(
  e: Pick<KeyboardEvent, "isComposing" | "keyCode">,
): boolean {
  return e.isComposing || e.keyCode === 229;
}
