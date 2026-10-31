// Native sidebar registration exposed by the slot registry to client plugins.
export function sidebarEntries() {
  return [{
    component: () => null,
    children: { 'sidebar.workspaces.session.row.action': { kind: 'list', scope: 'root' } },
  }];
}
