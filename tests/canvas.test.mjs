import test from 'node:test';
import assert from 'node:assert/strict';
import { Canvas } from '../public/canvas.js';

function element() {
  const classes = new Set(), captures = new Set(), listeners = new Map();
  return {
    style: {}, dataset: {}, clientWidth: 800, clientHeight: 600,
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    addEventListener(name, listener) { listeners.set(name, listener); },
    emit(name, event) { listeners.get(name)?.(event); },
    setPointerCapture: id => captures.add(id),
    hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id),
    focus() { this.focused = true; },
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
  };
}

function fixture(t) {
  const el = element(), nodeEl = element(), nodesEl = element(), windowEl = element();
  nodeEl.dataset.id = 'doc';
  el.parentElement = { style: {} };
  const elements = { '#canvas': el, '#canvas-world': element(), '#nodes': nodesEl, '#edge-paths': element() };
  const original = { document: globalThis.document, window: globalThis.window, ResizeObserver: globalThis.ResizeObserver };
  globalThis.document = { querySelector: selector => elements[selector] };
  globalThis.window = windowEl;
  globalThis.ResizeObserver = class { observe() {} };
  t.after(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  });
  const node = { id: 'doc', x: 100, y: 200, width: 310 };
  let task = { nodes: [node], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  let changes = 0;
  const selected = [], edited = [];
  const canvas = new Canvas({
    getTask: () => task,
    isConnecting: () => false,
    onSelect: id => selected.push(id),
    onEdit: id => edited.push(id),
    onChange: () => changes++,
  });
  canvas.updateTransform = () => {};
  canvas.renderEdges = () => {};
  const target = (interactive = null, onCard = true) => ({
    closest(selector) {
      if (selector === '.node') return onCard ? nodeEl : null;
      return interactive && selector.includes(interactive) ? {} : null;
    },
  });
  const event = (overrides = {}) => ({
    button: 0, pointerId: 1, clientX: 100, clientY: 100, target: target(),
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    ...overrides,
  });
  return { canvas, el, nodeEl, windowEl, node, task, selected, edited, target, event,
    changes: () => changes, switchTask: next => { task = next; } };
}

test('拖动文档内容从按下时阻止选字，并按画布缩放计算位置', t => {
  const f = fixture(t);
  f.task.viewport.zoom = 0.5;
  const down = f.event();
  f.canvas.pointerDown(down);
  assert.equal(down.defaultPrevented, true);
  assert.equal(f.nodeEl.hasPointerCapture(1), true);
  assert.equal(f.nodeEl.focused, true);
  assert.deepEqual(f.selected, ['doc']);
  f.canvas.pointerMove(f.event({ clientX: 120, clientY: 130 }));
  assert.deepEqual([f.node.x, f.node.y], [140, 260]);
  assert.equal(f.nodeEl.classList.contains('dragging'), true);
  f.canvas.pointerUp(f.event());
  assert.equal(f.changes(), 1);
  assert.equal(f.nodeEl.hasPointerCapture(1), false);
  assert.equal(f.nodeEl.classList.contains('dragging'), false);
  const click = f.event();
  f.el.emit('click', click);
  assert.equal(click.propagationStopped, true);
});

test('小幅抖动不移动卡片，普通双击仍打开文档', t => {
  const f = fixture(t);
  f.canvas.pointerDown(f.event());
  f.canvas.pointerMove(f.event({ clientX: 102, clientY: 101 }));
  f.canvas.pointerUp(f.event());
  f.el.emit('dblclick', f.event());
  assert.deepEqual([f.node.x, f.node.y], [100, 200]);
  assert.equal(f.changes(), 0);
  assert.deepEqual(f.edited, ['doc']);
});

test('按钮、链接、输入和连线保留自身左键操作', t => {
  const f = fixture(t);
  for (const selector of ['button', 'a', 'input', 'textarea', 'select', 'contenteditable', '.edge-group']) {
    const event = f.event({ target: f.target(selector) });
    f.canvas.pointerDown(event);
    f.el.emit('dblclick', event);
    assert.equal(f.canvas.drag, null, selector);
    assert.equal(event.defaultPrevented, undefined, selector);
  }
  assert.deepEqual(f.selected, []);
  assert.deepEqual(f.edited, []);
});

test('中键在卡片链接上平移画布，保留卡片位置和选择', t => {
  const f = fixture(t);
  f.canvas.pointerDown(f.event({ button: 1, target: f.target('a') }));
  assert.equal(f.el.hasPointerCapture(1), true);
  f.canvas.pointerMove(f.event({ button: 1, clientX: 140, clientY: 70 }));
  f.canvas.pointerUp(f.event({ button: 1 }));
  assert.deepEqual(f.task.viewport, { x: 40, y: -30, zoom: 1 });
  assert.deepEqual([f.node.x, f.node.y], [100, 200]);
  assert.deepEqual(f.selected, []);
  const auxclick = f.event({ button: 1 });
  f.el.emit('auxclick', auxclick);
  assert.equal(auxclick.defaultPrevented, true);
});

test('取消手势、失去捕获或窗口失焦均结束拖动且只保存一次', t => {
  const f = fixture(t);
  for (const reason of ['pointercancel', 'lostpointercapture', 'blur']) {
    const before = f.changes();
    f.canvas.pointerDown(f.event({ target: f.target(null, false) }));
    f.canvas.pointerMove(f.event({ clientX: 150 }));
    if (reason === 'blur') f.windowEl.emit('blur'); else f.el.emit(reason, f.event());
    const endX = f.task.viewport.x;
    f.canvas.pointerMove(f.event({ clientX: 200 }));
    f.canvas.pointerUp(f.event());
    assert.equal(f.canvas.drag, null, reason);
    assert.equal(f.el.hasPointerCapture(1), false, reason);
    assert.equal(f.el.classList.contains('panning'), false, reason);
    assert.equal(f.task.viewport.x, endX, reason);
    assert.equal(f.changes(), before + 1, reason);
  }
});

test('另一个指针或切换任务不会接管未结束的拖动', t => {
  const f = fixture(t);
  f.canvas.pointerDown(f.event());
  f.canvas.pointerDown(f.event({ pointerId: 2, clientX: 500 }));
  f.canvas.pointerMove(f.event({ pointerId: 2, clientX: 600 }));
  assert.equal(f.canvas.drag.pointerId, 1);
  assert.equal(f.node.x, 100);
  const next = { nodes: [], viewport: { x: 50, y: 60, zoom: 1 } };
  f.switchTask(next);
  f.canvas.pointerMove(f.event({ clientX: 300 }));
  assert.equal(f.canvas.drag, null);
  assert.deepEqual(next.viewport, { x: 50, y: 60, zoom: 1 });
  assert.equal(f.node.x, 100);
});

test('触控板双指平移、鼠标行滚动和 Shift 横向滚动使用一致单位', t => {
  const f = fixture(t);
  f.canvas.wheel(f.event({ deltaX: 12, deltaY: 20, deltaMode: 0 }));
  assert.deepEqual(f.task.viewport, { x: -12, y: -20, zoom: 1 });
  f.canvas.wheel(f.event({ deltaX: 0, deltaY: 2, deltaMode: 1, shiftKey: true }));
  assert.deepEqual(f.task.viewport, { x: -44, y: -20, zoom: 1 });
  f.canvas.wheel(f.event({ deltaX: 0, deltaY: 1, deltaMode: 2 }));
  assert.equal(f.task.viewport.y, -620);
});

test('捏合或 Command 滚轮围绕光标缩放，达到缩放边界也不漂移', t => {
  const f = fixture(t);
  for (const modifier of ['ctrlKey', 'metaKey']) {
    f.task.viewport = { x: 20, y: 40, zoom: 1 };
    const anchor = { x: 200, y: 150 };
    const world = { x: anchor.x - 20, y: anchor.y - 40 };
    f.canvas.wheel(f.event({ clientX: anchor.x + 10, clientY: anchor.y + 20, deltaX: 0, deltaY: -100, deltaMode: 0, [modifier]: true }));
    const view = f.task.viewport;
    assert.ok(view.zoom > 1);
    assert.ok(Math.abs(view.x + world.x * view.zoom - anchor.x) < 1e-9);
    assert.ok(Math.abs(view.y + world.y * view.zoom - anchor.y) < 1e-9);
    f.canvas.zoom(100, anchor.x, anchor.y);
    const before = { ...view };
    f.canvas.zoom(100, anchor.x, anchor.y);
    assert.deepEqual(view, before);
  }
});
