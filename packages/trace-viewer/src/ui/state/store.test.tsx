// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTraceIndex, emptyTraceIndex } from "../../layout/trace-index.js";
import { oauthLikeSession } from "../../test-support/session-builder.js";
import { createViewStore, useDispatch, useView, ViewStoreContext, type ViewStore } from "./store.js";
import { initialViewState } from "./view-state.js";

afterEach(() => cleanup());

function mount(store: ViewStore, counter: { renders: number }) {
  function LevelLabel() {
    counter.renders += 1;
    const level = useView((s) => s.level);
    return <span data-testid="level">{level}</span>;
  }
  return render(
    <ViewStoreContext.Provider value={store}>
      <LevelLabel />
    </ViewStoreContext.Provider>,
  );
}

describe("view store", () => {
  it("useView re-renders only when its selected slice changes", () => {
    const store = createViewStore(initialViewState({ live: false }), emptyTraceIndex("s"));
    const counter = { renders: 0 };
    const view = mount(store, counter);
    expect(counter.renders).toBe(1);
    act(() => store.dispatch({ type: "tool/set", tool: "hand" }));
    act(() => store.dispatch({ type: "inspector/tab", tab: "evidence" }));
    expect(counter.renders).toBe(1);
    act(() => store.dispatch({ type: "level/set", level: "step", by: "shell" }));
    expect(counter.renders).toBe(2);
    expect(view.getByTestId("level").textContent).toBe("step");
  });

  it("does not notify when reduce returns the same state", () => {
    const store = createViewStore(initialViewState({ live: false }), emptyTraceIndex("s"));
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.dispatch({ type: "tool/set", tool: "select" });
    expect(listener).not.toHaveBeenCalled();
    store.dispatch({ type: "tool/set", tool: "hand" });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.dispatch({ type: "tool/set", tool: "select" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reduces against the index set last", () => {
    const session = oauthLikeSession();
    const store = createViewStore(initialViewState({ live: false }), emptyTraceIndex(session.meta.sessionId));
    const target = session.steps[3]?.id ?? "step:1";
    store.dispatch({ type: "select", id: target, by: "shell" });
    expect(store.get().selection).toBeNull();
    store.setIndex(buildTraceIndex(session));
    store.dispatch({ type: "select", id: target, by: "shell" });
    expect(store.get().selection).toBe(target);
    expect(store.getIndex().session).toBe(session);
  });

  it("a custom equality keeps a derived value stable", () => {
    const store = createViewStore(initialViewState({ live: false }), emptyTraceIndex("s"));
    const counter = { renders: 0 };
    function Expanded() {
      counter.renders += 1;
      const size = useView((s) => s.expanded, (a, b) => a.size === b.size);
      const dispatch = useDispatch();
      return <button type="button" onClick={() => dispatch({ type: "tool/set", tool: "hand" })}>{size.size}</button>;
    }
    render(<ViewStoreContext.Provider value={store}><Expanded /></ViewStoreContext.Provider>);
    act(() => store.dispatch({ type: "expand/set", key: "unit:a", expanded: true }));
    expect(counter.renders).toBe(2);
    act(() => store.dispatch({ type: "tool/set", tool: "hand" }));
    expect(counter.renders).toBe(2);
  });
});
