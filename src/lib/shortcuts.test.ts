import { describe, expect, test } from "bun:test";
import {
  classifyGlobalShortcut,
  isEditableTarget,
  isMacPlatform,
  submitShortcutLabel,
} from "./shortcuts.ts";

function makeKeyEvent(
  overrides: Partial<Parameters<typeof classifyGlobalShortcut>[0]> = {},
): Parameters<typeof classifyGlobalShortcut>[0] {
  return {
    key: "n",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 78,
    defaultPrevented: false,
    target: {
      tagName: "DIV",
      isContentEditable: false,
    } as unknown as EventTarget,
    ...overrides,
  };
}

describe("shortcuts", () => {
  test("detects Apple vs non-Apple submit shortcut label", () => {
    expect(isMacPlatform({ platform: "MacIntel" })).toBe(true);
    expect(submitShortcutLabel({ platform: "MacIntel" })).toBe("⌘Enter");
    expect(submitShortcutLabel({ userAgentData: { platform: "macOS" } })).toBe(
      "⌘Enter",
    );
    expect(isMacPlatform({ platform: "Linux x86_64" })).toBe(false);
    expect(submitShortcutLabel({ platform: "Win32" })).toBe("Ctrl+Enter");
    expect(submitShortcutLabel(undefined)).toBe("Ctrl+Enter");
  });

  test("identifies editable targets accurately", () => {
    expect(
      isEditableTarget({ tagName: "INPUT" } as unknown as EventTarget),
    ).toBe(true);
    expect(
      isEditableTarget({ tagName: "TEXTAREA" } as unknown as EventTarget),
    ).toBe(true);
    expect(
      isEditableTarget({ tagName: "SELECT" } as unknown as EventTarget),
    ).toBe(true);
    expect(
      isEditableTarget({
        tagName: "DIV",
        isContentEditable: true,
      } as unknown as EventTarget),
    ).toBe(true);
    expect(
      isEditableTarget({
        tagName: "DIV",
        getAttribute: (k: string) => (k === "role" ? "textbox" : null),
      } as unknown as EventTarget),
    ).toBe(true);
    expect(
      isEditableTarget({
        tagName: "BUTTON",
        isContentEditable: false,
      } as unknown as EventTarget),
    ).toBe(false);
  });

  test("classifies n/c compose and / search when safe", () => {
    expect(
      classifyGlobalShortcut(makeKeyEvent({ key: "n" }), { dialogOpen: false }),
    ).toBe("compose");
    expect(
      classifyGlobalShortcut(makeKeyEvent({ key: "c" }), { dialogOpen: false }),
    ).toBe("compose");
    expect(
      classifyGlobalShortcut(makeKeyEvent({ key: "/" }), { dialogOpen: false }),
    ).toBe("search");
  });

  test("blocks shortcuts during IME composition, modifiers, editable focus, or open overlays", () => {
    expect(
      classifyGlobalShortcut(makeKeyEvent({ isComposing: true }), {
        dialogOpen: false,
      }),
    ).toBeNull();
    expect(
      classifyGlobalShortcut(makeKeyEvent({ keyCode: 229 }), {
        dialogOpen: false,
      }),
    ).toBeNull();
    expect(
      classifyGlobalShortcut(makeKeyEvent({ ctrlKey: true }), {
        dialogOpen: false,
      }),
    ).toBeNull();
    expect(
      classifyGlobalShortcut(makeKeyEvent({ metaKey: true }), {
        dialogOpen: false,
      }),
    ).toBeNull();
    expect(
      classifyGlobalShortcut(makeKeyEvent({ altKey: true }), {
        dialogOpen: false,
      }),
    ).toBeNull();
    expect(
      classifyGlobalShortcut(makeKeyEvent({ shiftKey: true, key: "N" }), {
        dialogOpen: false,
      }),
    ).toBeNull();
    expect(
      classifyGlobalShortcut(
        makeKeyEvent({
          target: { tagName: "TEXTAREA" } as unknown as EventTarget,
        }),
        { dialogOpen: false },
      ),
    ).toBeNull();
    expect(
      classifyGlobalShortcut(makeKeyEvent(), { dialogOpen: true }),
    ).toBeNull();
    expect(
      classifyGlobalShortcut(makeKeyEvent(), {
        dialogOpen: false,
        menuOpen: true,
      }),
    ).toBeNull();
  });
});
