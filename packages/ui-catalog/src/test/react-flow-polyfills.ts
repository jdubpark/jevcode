class ResizeObserverMock {
  private callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    const entry = {
      target,
      contentRect: {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 768,
        right: 1024,
        width: 1024,
        height: 768,
        toJSON: () => ({}),
      },
    } as ResizeObserverEntry;
    queueMicrotask(() => {
      this.callback([entry], this as unknown as ResizeObserver);
    });
  }

  unobserve() {}

  disconnect() {}
}

class DOMMatrixReadOnlyMock {
  m11 = 1;
  m12 = 0;
  m21 = 0;
  m22 = 1;
  m41 = 0;
  m42 = 0;
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  isIdentity = true;
  is2D = true;
  translate() {
    return this;
  }
  scale() {
    return this;
  }
  multiply() {
    return this;
  }
  inverse() {
    return this;
  }
  toString() {
    return "matrix(1, 0, 0, 1, 0, 0)";
  }
}

interface GlobalWithDOM {
  ResizeObserver?: unknown;
  DOMMatrixReadOnly?: unknown;
  DOMMatrix?: unknown;
  HTMLElement: {
    prototype: {
      offsetWidth?: number;
      offsetHeight?: number;
    };
  };
  SVGElement: {
    prototype: {
      getBBox?: () => DOMRect;
    };
  };
}

const NODE_OFFSET_WIDTH = 220;
const NODE_OFFSET_HEIGHT = 64;

export function installReactFlowPolyfills(): void {
  const global = globalThis as unknown as GlobalWithDOM;
  if (global.ResizeObserver === undefined) {
    global.ResizeObserver = ResizeObserverMock;
  }
  if (global.DOMMatrixReadOnly === undefined) {
    global.DOMMatrixReadOnly = DOMMatrixReadOnlyMock;
  }
  if (global.DOMMatrix === undefined) {
    global.DOMMatrix = DOMMatrixReadOnlyMock;
  }
  if (global.SVGElement.prototype.getBBox === undefined) {
    global.SVGElement.prototype.getBBox = () => ({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    });
  }
  Object.defineProperty(global.HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return NODE_OFFSET_WIDTH;
    },
  });
  Object.defineProperty(global.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return NODE_OFFSET_HEIGHT;
    },
  });
}
