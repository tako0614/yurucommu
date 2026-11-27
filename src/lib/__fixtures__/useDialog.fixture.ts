import assert from "node:assert/strict";
import { createRoot, createSignal } from "solid-js";
import { useDialog } from "../useDialog.ts";

class StubElement {
  isConnected = true;
  tabIndex = 0;
  focused = false;
  offsetParent: object | null = {};
  private attrs = new Map<string, string>();

  focus() {
    this.focused = true;
    (globalThis.document as unknown as StubDocument).activeElement = this;
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
    if (name === "tabindex") this.tabIndex = Number(value);
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attrs.has(name);
  }
  closest() {
    return null;
  }
  contains(node: unknown) {
    return node === this;
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  getClientRects() {
    return [{ width: 10, height: 10 }];
  }
}

class StubDocument {
  activeElement: StubElement | null = null;
  body = { style: { overflow: "" } };
  private listeners: Array<{
    type: string;
    fn: (e: KeyboardEvent) => void;
    capture: boolean;
  }> = [];

  addEventListener(
    type: string,
    fn: (e: KeyboardEvent) => void,
    capture?: boolean,
  ) {
    this.listeners.push({ type, fn, capture: Boolean(capture) });
  }
  removeEventListener(
    type: string,
    fn: (e: KeyboardEvent) => void,
    capture?: boolean,
  ) {
    this.listeners = this.listeners.filter(
      (l) =>
        !(l.type === type && l.fn === fn && l.capture === Boolean(capture)),
    );
  }
  dispatchKeyDown(init: {
    key: string;
    isComposing?: boolean;
    keyCode?: number;
  }) {
    let prevented = false;
    let stopped = false;
    const event = {
      key: init.key,
      isComposing: init.isComposing ?? false,
      keyCode: init.keyCode ?? 0,
      shiftKey: false,
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
    } as unknown as KeyboardEvent;
    for (const listener of [...this.listeners]) {
      if (listener.type === "keydown") listener.fn(event);
    }
    return { prevented, stopped };
  }
  querySelector() {
    return null;
  }
}

const doc = new StubDocument();
Object.defineProperty(globalThis, "document", {
  value: doc,
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, "HTMLElement", {
  value: StubElement,
  configurable: true,
  writable: true,
});

const scenario = process.argv[2];

if (scenario === "ime-escape") {
  let closed = 0;
  const rootEl = new StubElement() as unknown as HTMLElement;
  const dispose = createRoot((d) => {
    const [open] = createSignal(true);
    useDialog({
      isOpen: open,
      onClose: () => {
        closed += 1;
      },
      container: () => rootEl,
    });
    return d;
  });
  try {
    const ime1 = doc.dispatchKeyDown({
      key: "Escape",
      isComposing: true,
      keyCode: 27,
    });
    assert.equal(closed, 0);
    assert.equal(ime1.prevented, false);

    // Safari reports keyCode 229 even after isComposing flips false.
    const ime2 = doc.dispatchKeyDown({
      key: "Escape",
      isComposing: false,
      keyCode: 229,
    });
    assert.equal(closed, 0);
    assert.equal(ime2.prevented, false);

    const plain = doc.dispatchKeyDown({
      key: "Escape",
      isComposing: false,
      keyCode: 27,
    });
    assert.equal(closed, 1);
    assert.equal(plain.prevented, true);
  } finally {
    dispose();
  }
} else if (scenario === "stacked-ime-escape") {
  let baseClosed = 0;
  let topClosed = 0;
  const baseEl = new StubElement() as unknown as HTMLElement;
  const topEl = new StubElement() as unknown as HTMLElement;

  const dispose = createRoot((d) => {
    const [baseOpen] = createSignal(true);
    const [topOpen, setTopOpen] = createSignal(true);
    useDialog({
      isOpen: baseOpen,
      onClose: () => {
        baseClosed += 1;
      },
      container: () => baseEl,
    });
    useDialog({
      isOpen: topOpen,
      onClose: () => {
        topClosed += 1;
        setTopOpen(false);
      },
      container: () => topEl,
    });
    return d;
  });
  try {
    doc.dispatchKeyDown({ key: "Escape", isComposing: true, keyCode: 27 });
    assert.equal(topClosed, 0);
    assert.equal(baseClosed, 0);

    doc.dispatchKeyDown({ key: "Escape", isComposing: false, keyCode: 27 });
    assert.equal(topClosed, 1);
    assert.equal(baseClosed, 0);

    doc.dispatchKeyDown({ key: "Escape", isComposing: false, keyCode: 27 });
    assert.equal(baseClosed, 1);
  } finally {
    dispose();
  }
} else {
  throw new Error(`Unknown scenario: ${scenario}`);
}

console.log(JSON.stringify({ scenario, passed: true }));
