import { describe, expect, test } from "bun:test";
import { isComposingKey } from "./ime.ts";

describe("isComposingKey", () => {
  test("treats the Enter that confirms a conversion as composing", () => {
    // Chrome / Firefox
    expect(isComposingKey({ isComposing: true, keyCode: 13 })).toBe(true);
    // Safari: isComposing is already false, keyCode is the IME's 229
    expect(isComposingKey({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  test("lets a plain Enter through", () => {
    expect(isComposingKey({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});
