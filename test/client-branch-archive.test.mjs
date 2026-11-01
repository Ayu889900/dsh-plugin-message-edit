import { sidebarEntries } from './fixtures/sidebar-entry.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createLocale } from './fixtures/locale-runtime.mjs';

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function versions(archived) {
  const root = { sessionId: 'root', createdAt: 1, turns: [
    { turn: 1, text: 'Original', time: 2 }, { turn: 2, text: 'Later', time: 3 },
  ] };
  const branch = { sessionId: 'branch', parentSessionId: 'root', targetTurn: 1, operation: 'edit', createdAt: 4,
    archived: archived.has('branch'), turns: [
      { turn: 1, text: 'Branch', time: 5 }, { turn: 2, text: 'Branch later', time: 6 },
    ] };
  const leaf = { sessionId: 'leaf', parentSessionId: 'branch', targetTurn: 2, operation: 'retry', createdAt: 7,
    archived: archived.has('leaf'), turns: [{ turn: 2, text: 'Leaf', time: 8 }] };
  const sibling = { sessionId: 'sibling', parentSessionId: 'root', targetTurn: 1, operation: 'edit', createdAt: 9,
    turns: [{ turn: 1, text: 'Sibling', time: 10 }] };
  return [root, branch, leaf, sibling];
}

async function mount(t, sessionId = 'root', options = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'https://message-edit.test/', pretendToBeVisual: true,
  });
  dom.window.confirm = () => true;
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const archived = new Set();
  const archiveCalls = [];
  const restoreCalls = [];
  const opened = [];
  let failArchiveId = options.failArchiveId;
  dom.window.fetch = async url => ({ ok: true, json: async () => ({ versions: versions(archived) }) });
  let component;
  let plugin;
  dom.window.__ModuleLoader__ = { load({ factory }) {
    plugin = factory(name => name === 'react' ? React : {});
  } };
  runInNewContext(bundle, {
    window: dom.window, document: dom.window.document, console,
    setTimeout, clearTimeout,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  });
  const sessions = { list: {
    subscribe: () => () => {},
    getSnapshot: () => ({ byId: Object.fromEntries(['root', 'branch', 'leaf', 'sibling'].map(id => [id, { id }])) }),
  } };
  const uiWorkspace = {
    openSession: id => { opened.push(id); },
    async archiveSession(id, options) {
      archiveCalls.push({ id, options });
      if (id === failArchiveId) {
        failArchiveId = undefined;
        throw new Error('archive unavailable');
      }
      archived.add(id);
      workspaceListeners.forEach(listener => listener());
    },
    async unarchiveSession(id) {
      restoreCalls.push(id);
      archived.delete(id);
      workspaceListeners.forEach(listener => listener());
    },
  };
  const workspaceListeners = new Set();
  const workspaces = { list: { subscribe(listener) { workspaceListeners.add(listener); return () => workspaceListeners.delete(listener); } } };
  const setArchivedExternally = (id, value) => {
    if (value) archived.add(id);
    else archived.delete(id);
    workspaceListeners.forEach(listener => listener());
  };
  const slots = {
    entries: sidebarEntries,
    inject(_name, register) { register(); },
    register(spec, view) {
      if (spec.name === 'conversation.view' && spec.id === 'message-tree') component = view;
      return () => {};
    },
  };
  const disposers = [];
  plugin.apply({
    get: name => ({ slots, sessions, uiWorkspace, workspaces, locale: createLocale(['en']) })[name],
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  });
  assert.equal(typeof component, 'function');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => root.render(React.createElement(component, { sessionId })));
  await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
  t.after(async () => {
    await act(async () => root.unmount());
    for (const dispose of disposers.reverse()) dispose();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { dom, archiveCalls, restoreCalls, opened, setArchivedExternally };
}

test('hover branch actions archive descendants, hide them and restore the whole archived branch', async t => {
  const { dom, archiveCalls, restoreCalls } = await mount(t);
  const doc = dom.window.document;
  assert.equal(doc.querySelector('[data-id="root#root"] .mtx-card-action'), null, 'Original has no archive action');
  assert.equal(doc.querySelector('[data-id="branch#t2"] .mtx-card-action'), null, 'Only one action per branch');
  assert.equal(doc.querySelector('[data-id="branch#t1"] [data-action="archive-branch"]')?.textContent, '×');
  assert.match(doc.querySelector('style[data-plugin="dsh-plugin-message-edit"]').textContent,
    /\.mtx-card:hover \.mtx-card-action/);

  await act(async () => doc.querySelector('[data-id="branch#t1"] [data-action="archive-branch"]').click());
  assert.deepEqual(archiveCalls.map(call => call.id), ['leaf', 'branch'], 'Archive descendants before their parent');
  assert.ok(archiveCalls.every(call => call.options.stopActivity), 'Stop active work for each archived session');
  assert.equal(doc.querySelector('[data-id="branch#t1"]'), null);
  assert.equal(doc.querySelector('[data-id="leaf#t2"]'), null);
  assert.ok(doc.querySelector('[data-id="sibling#t1"]'));
  assert.match(doc.querySelector('.mtx-archived-toggle').textContent, /Show archived \(1\)/);

  await act(async () => {
    doc.querySelector('.mtx-archived-toggle input').click();
  });
  assert.ok(doc.querySelector('[data-id="branch#t1"]'));
  assert.ok(doc.querySelector('[data-id="leaf#t2"]'));
  assert.equal(doc.querySelector('[data-id="branch#t1"] [data-action="restore-branch"]')?.textContent, '↶');
  assert.equal(doc.querySelector('[data-id="leaf#t2"] .mtx-card-action'), null);
  await act(async () => doc.querySelector('[data-id="branch#t1"] [data-action="restore-branch"]').click());
  assert.deepEqual(restoreCalls, ['branch', 'leaf'], 'Restore the parent before its descendants');
  assert.ok(doc.querySelector('[data-id="branch#t1"]'));
  assert.ok(doc.querySelector('[data-id="leaf#t2"]'));
  assert.equal(doc.querySelector('[data-id="branch#t1"] [data-action="archive-branch"]')?.textContent, '×');
});

test('archiving the currently open branch navigates to its live parent first', async t => {
  const { dom, archiveCalls, opened } = await mount(t, 'branch');
  await act(async () => dom.window.document.querySelector('[data-id="branch#t1"] [data-action="archive-branch"]').click());
  assert.deepEqual(opened, ['root']);
  assert.deepEqual(archiveCalls.map(call => call.id), ['leaf', 'branch']);
});

test('a partial archive stays visible, reports failure and can be retried safely', async t => {
  const { dom, archiveCalls } = await mount(t, 'root', { failArchiveId: 'branch' });
  const doc = dom.window.document;
  await act(async () => doc.querySelector('[data-id="branch#t1"] [data-action="archive-branch"]').click());
  assert.equal(doc.querySelector('[data-id="leaf#t2"]'), null, 'The completed leaf archive is hidden');
  assert.ok(doc.querySelector('[data-id="branch#t1"]'), 'The unarchived parent remains available');
  assert.match(doc.querySelector('.mtx-error').textContent, /partly archived/);
  await act(async () => doc.querySelector('[data-id="branch#t1"] [data-action="archive-branch"]').click());
  assert.deepEqual(archiveCalls.map(call => call.id), ['leaf', 'branch', 'branch']);
  assert.equal(doc.querySelector('[data-id="branch#t1"]'), null);
  assert.equal(doc.querySelector('.mtx-error'), null);
});

test('archive changes from another client refresh the visible tree', async t => {
  const { dom, setArchivedExternally } = await mount(t);
  const doc = dom.window.document;
  await act(async () => {
    setArchivedExternally('leaf', true);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.equal(doc.querySelector('[data-id="leaf#t2"]'), null);
  assert.match(doc.querySelector('.mtx-archived-toggle').textContent, /Show archived \(1\)/);
});

test('graph zoom scales cards and edges together', async t => {
  const { dom } = await mount(t);
  const doc = dom.window.document;
  const graph = doc.querySelector('.mtx-graph');
  const world = doc.querySelector('.mtx-world');
  const before = world.style.transform;
  await act(async () => graph.dispatchEvent(new dom.window.WheelEvent('wheel', {
    deltaY: -1000, clientX: 100, clientY: 100, cancelable: true,
  })));
  assert.notEqual(world.style.transform, before, 'Zoom updates the shared canvas transform');
  assert.match(world.style.transform, /scale\(1\.8\)/);
  assert.match(doc.querySelector('style[data-plugin="dsh-plugin-message-edit"]').textContent,
    /margin:2px 0 0 -32px;width:calc\(100% \+ 32px\)/);
  assert.ok(doc.querySelector('.mtx-edge').getAttribute('d'));
});
