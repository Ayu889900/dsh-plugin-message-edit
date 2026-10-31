import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

for (const prefs of [
  { collapseBranches: true, rememberPath: true },
  { collapseBranches: true, rememberPath: false },
  { collapseBranches: false, rememberPath: true },
]) {
test(`native sidebar projection preserves capabilities: ${JSON.stringify(prefs)}`, () => {
  const React = {
    Component: class {}, createContext: () => ({}),
    useMemo: fn => fn(), useRef: value => ({ current: value }),
    useState: value => [value, () => {}], useReducer: () => [0, () => {}],
    useEffect() {}, useLayoutEffect() {}, useDebugValue() {},
    useSyncExternalStore: (_subscribe, get) => get(),
    createElement: (component, props) => ({ component, props }),
  };
  let moduleValue;
  const sandbox = {
    console,
    window: { localStorage: { getItem(key) {
      if (key.endsWith(':prefs')) return JSON.stringify(prefs);
      if (key.endsWith(':active-path')) return JSON.stringify({ root: 'child' });
      return null;
    } }, __ModuleLoader__: { load({ factory }) {
      moduleValue = factory(name => {
        if (name === 'react') return React;
        if (name === 'react/jsx-runtime') return { jsx: React.createElement };
        if (name === '@deepseek-ai/cordis') return { Service: class {} };
        if (name === '@deepseek-ai/dsh-client-ui-slots') return {
          standardHookPropName: name => 'use' + name[0].toUpperCase() + name.slice(1),
        };
        return {};
      });
    } } },
  };
  // Exercise DSH's actual prop assembly: the original shadow registration
  // dropped these capabilities and failed with "useHostInfo is not a function".
  const modules = process.env.DSH_QA_MODULES ?? fileURLToPath(new URL('../node_modules/', import.meta.url));
  const rendererSource = readFileSync(resolve(modules, '@deepseek-ai/dsh-client-ui-renderer/lib/client.js'), 'utf8');
  runInNewContext(rendererSource.replace('exports.SlotRegistry = SlotRegistry;',
    'exports.probe = { standardKit, cachedRootInject }; exports.SlotRegistry = SlotRegistry;'), sandbox);
  const renderer = moduleValue.probe;
  const source = value => ({ getSnapshot: () => value, subscribe: () => () => {} });
  let list = { ids: ['root', 'child', 'other', 'agent'], byId: {
    root: { id: 'root', retainedBy: {} },
    child: { id: 'child', parentId: 'root', retainedBy: { mainView: 1 } },
    other: { id: 'other', retainedBy: {} },
    agent: { id: 'agent', parentId: 'root', origin: 'subagent', retainedBy: {} },
  } };
  let workspaces = { archivedSessionIds: [], items: [{ workspaceId: 'w', sessionIds: list.ids.slice() }] };
  const sessionSource = { getSnapshot: () => list, subscribe: () => () => {} };
  function NativeSidebar(props) {
    for (const name of ['useSessions', 'useWorkspaces', 'useHostInfo', 'useShortcuts',
      'useWorkspaceShortcuts', 'useDirectoryFlow', 'useStore', 'renderSlot', 't']) {
      assert.equal(typeof props[name], 'function', 'Missing ' + name);
    }
    props.useHostInfo(x => x); props.useShortcuts(x => x);
    props.useWorkspaceShortcuts(x => x); props.useDirectoryFlow(x => x);
    props.useStore(x => x); props.t('workspace.defaultName');
    props.renderSlot('sidebar.workspaces.session.row.action', { sessionId: 'child' });
    return { list: props.useSessions(x => x), workspaces: props.useWorkspaces(x => x) };
  }
  const entry = {
    component: NativeSidebar, options: {}, locale: 'workspace',
    store: Object.assign(source({ groupBy: 'workspace' }), { actions: {} }),
    children: { 'sidebar.workspaces.session.row.action': { kind: 'list', scope: 'root' } },
    inject: () => ({ hooks: {
      hostInfo: source({}), shortcuts: source([]), workspaceShortcuts: source({}), directoryFlow: source(true),
    } }),
  };
  const originalMetadata = { ...entry };
  const injections = new Map();
  const slots = {
    entries: () => [entry], entriesOfSlot: () => [entry],
    inject: (name, cb) => injections.set(name, cb), onEntryError: () => () => {},
  };
  const services = { slots, sessions: { list: sessionSource }, uiWorkspace: { openSession() {} },
    locale: { register() {}, bind: () => key => key } };
  runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox);
  moduleValue.apply({ get: name => services[name], effect: fn => fn() });
  assert.equal(injections.has('sidebar.workspaces'), false, 'Must not shadow native registration');
  const restore = injections.get('sidebar.workspaces.session.row.action')();
  for (const key of ['inject', 'store', 'locale', 'children']) assert.equal(entry[key], originalMetadata[key]);
  const root = { hooks: { sessions: sessionSource,
    workspaces: { getSnapshot: () => workspaces, subscribe: () => () => {} } }, keyedHooks: {}, props: {} };
  const host = { storeOf: e => e.store, isLive: e => e === entry,
    locale: { getSnapshot: () => ({ revision: 1 }), bind: () => key => key } };
  function render(expected) {
    if (!prefs.collapseBranches) expected = list.ids;
    const { kit, actions } = renderer.standardKit(host, entry, 'root', root);
    const child = entry.component({ ...kit, ...renderer.cachedRootInject(entry, actions) });
    assert.equal(child.component, NativeSidebar);
    const projected = child.component(child.props);
    assert.deepEqual(Array.from(projected.list.ids), expected);
    assert.deepEqual(Array.from(projected.workspaces.items[0].sessionIds),
      prefs.collapseBranches ? expected : workspaces.items[0].sessionIds);
    assert.equal(projected.list.byId, list.byId, 'Hidden branches remain addressable');
  }
  render(['child', 'other', 'agent']);
  assert.equal(list.ids.length, 4);
  assert.equal(workspaces.items[0].sessionIds.length, 4);
  list = { ...list, byId: { ...list.byId, child: { ...list.byId.child, retainedBy: {} },
    root: { ...list.byId.root, retainedBy: { mainView: 1 } } } };
  render(['root', 'other', 'agent']);
  list = { ...list, byId: { ...list.byId, root: { ...list.byId.root, retainedBy: {} } } };
  render([prefs.rememberPath ? 'child' : 'root', 'other', 'agent']);
  workspaces = { ...workspaces, archivedSessionIds: ['root'] };
  render(['root', 'child', 'other', 'agent']);
  list = { ...list, ids: list.ids.filter(id => id !== 'root'), byId: { ...list.byId } };
  delete list.byId.root;
  render(['child', 'other', 'agent']);
  restore();
  assert.equal(entry.component, NativeSidebar);
});
}
