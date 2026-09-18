import type { ActivationFunction, OutputItem, RendererContext } from 'vscode-notebook-renderer';
import {
  InvalidateMessage,
  PAGE_SIZE,
  ToExtension,
  ToRenderer,
  VariableHandle,
  VariableNode,
  VariablesResponse,
} from './protocol';

const STYLE = `
.dbgnb-tree { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); line-height: 1.5; }
.dbgnb-tree ul { list-style: none; margin: 0; padding-left: 1.2em; }
.dbgnb-tree > ul { padding-left: 0; }
.dbgnb-row { display: flex; align-items: baseline; white-space: pre-wrap; word-break: break-all; }
.dbgnb-chev { width: 1.2em; flex: none; cursor: pointer; user-select: none; color: var(--vscode-foreground); opacity: .7; }
.dbgnb-chev.empty { cursor: default; opacity: 0; }
.dbgnb-name { color: var(--vscode-debugTokenExpression-name, #9cdcfe); }
.dbgnb-value { color: var(--vscode-debugTokenExpression-value, inherit); }
.dbgnb-value.string { color: var(--vscode-debugTokenExpression-string, #ce9178); }
.dbgnb-value.number { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
.dbgnb-value.boolean { color: var(--vscode-debugTokenExpression-boolean, #4e94ce); }
.dbgnb-type { color: var(--vscode-debugTokenExpression-type, #4ec9b0); opacity: .8; margin-left: .5em; }
.dbgnb-note { color: var(--vscode-descriptionForeground); font-style: italic; }
.dbgnb-more { color: var(--vscode-textLink-foreground); cursor: pointer; }
.dbgnb-stale .dbgnb-chev { cursor: default; opacity: .25; }
`;

type Pending = { resolve: (r: VariablesResponse) => void };

export const activate: ActivationFunction = (context: RendererContext<void>) => {
  const pending = new Map<number, Pending>();
  const trees = new Set<Tree>();
  let nextRequest = 1;

  context.onDidReceiveMessage?.((raw: unknown) => {
    const msg = raw as ToRenderer;
    if (msg.type === 'variables') {
      pending.get(msg.requestId)?.resolve(msg);
      pending.delete(msg.requestId);
    } else if (msg.type === 'invalidate') {
      for (const t of trees) {
        t.onInvalidate(msg);
      }
    }
  });

  const request = (msg: Omit<ToExtension, 'requestId'>): Promise<VariablesResponse> => {
    if (!context.postMessage) {
      return Promise.resolve({ type: 'variables', requestId: 0, ok: false, reason: 'gone', message: 'no messaging' });
    }
    const requestId = nextRequest++;
    return new Promise((resolve) => {
      pending.set(requestId, { resolve });
      context.postMessage!({ ...msg, requestId });
      setTimeout(() => {
        if (pending.delete(requestId)) {
          resolve({ type: 'variables', requestId, ok: false, reason: 'error', message: 'timed out' });
        }
      }, 15000);
    });
  };

  return {
    renderOutputItem(item: OutputItem, element: HTMLElement, signal: AbortSignal) {
      element.innerHTML = '';
      let handle: VariableHandle;
      try {
        handle = item.json() as VariableHandle;
      } catch {
        element.textContent = item.text();
        return;
      }
      if (!element.ownerDocument.getElementById('dbgnb-style')) {
        const style = element.ownerDocument.createElement('style');
        style.id = 'dbgnb-style';
        style.textContent = STYLE;
        element.ownerDocument.head.appendChild(style);
      }
      const tree = new Tree(element, handle, request);
      trees.add(tree);
      signal.addEventListener('abort', () => trees.delete(tree));
    },
  };
};

class Tree {
  private stale = false;
  private readonly root: HTMLElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly handle: VariableHandle,
    private readonly request: (msg: Omit<ToExtension, 'requestId'>) => Promise<VariablesResponse>,
  ) {
    this.root = host.ownerDocument.createElement('div');
    this.root.className = 'dbgnb-tree';
    host.appendChild(this.root);
    const ul = this.el('ul');
    this.root.appendChild(ul);
    ul.appendChild(
      this.node({
        name: '',
        value: handle.result,
        type: handle.type,
        variablesReference: handle.variablesReference,
        indexedVariables: handle.indexedVariables,
        namedVariables: handle.namedVariables,
      }),
    );
  }

  onInvalidate(msg: InvalidateMessage): void {
    if (msg.sessionId !== this.handle.sessionId) {
      return;
    }
    if (msg.gone || msg.stopSeq !== this.handle.stopSeq) {
      this.markStale(msg.gone ? 'session ended' : 'debuggee moved on');
    }
  }

  private markStale(why: string): void {
    if (this.stale) {
      return;
    }
    this.stale = true;
    this.root.classList.add('dbgnb-stale');
    const note = this.el('div', 'dbgnb-note');
    note.textContent = `○ tree frozen: ${why}. Re-run the cell to inspect again.`;
    this.root.appendChild(note);
  }

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
    const e = this.host.ownerDocument.createElement(tag);
    if (cls) {
      e.className = cls;
    }
    return e;
  }

  private node(v: VariableNode): HTMLLIElement {
    const li = this.el('li');
    const row = this.el('div', 'dbgnb-row');
    const chev = this.el('span', 'dbgnb-chev');
    const expandable = v.variablesReference > 0;
    chev.textContent = expandable ? '▸' : '';
    if (!expandable) {
      chev.classList.add('empty');
    }
    row.appendChild(chev);
    if (v.name) {
      const name = this.el('span', 'dbgnb-name');
      name.textContent = v.name;
      row.appendChild(name);
      row.appendChild(this.host.ownerDocument.createTextNode(': '));
    }
    const value = this.el('span', `dbgnb-value ${classify(v)}`);
    value.textContent = v.value;
    row.appendChild(value);
    if (v.type) {
      const type = this.el('span', 'dbgnb-type');
      type.textContent = v.type;
      row.appendChild(type);
    }
    li.appendChild(row);

    if (expandable) {
      let children: HTMLUListElement | undefined;
      let open = false;
      chev.onclick = async () => {
        if (this.stale) {
          return;
        }
        open = !open;
        chev.textContent = open ? '▾' : '▸';
        if (!open) {
          children?.remove();
          children = undefined;
          return;
        }
        children = this.el('ul');
        li.appendChild(children);
        await this.loadPage(children, v, 0);
      };
    }
    return li;
  }

  private async loadPage(into: HTMLUListElement, v: VariableNode, start: number): Promise<void> {
    const loading = this.el('li', 'dbgnb-note');
    loading.textContent = 'loading…';
    into.appendChild(loading);
    const paged = (v.indexedVariables ?? 0) > PAGE_SIZE;
    const res = await this.request({
      type: 'variables',
      sessionId: this.handle.sessionId,
      stopSeq: this.handle.stopSeq,
      variablesReference: v.variablesReference,
      ...(paged ? { start, count: PAGE_SIZE } : {}),
    });
    loading.remove();
    if (!res.ok) {
      if (res.reason === 'stale' || res.reason === 'gone' || res.reason === 'running') {
        this.markStale(
          res.reason === 'gone' ? 'session ended' : res.reason === 'running' ? 'debuggee is running' : 'debuggee moved on',
        );
      } else {
        const err = this.el('li', 'dbgnb-note');
        err.textContent = `error: ${res.message ?? 'unknown'}`;
        into.appendChild(err);
      }
      return;
    }
    for (const child of res.variables) {
      into.appendChild(this.node(child));
    }
    const next = start + res.variables.length;
    if (paged && next < (v.indexedVariables ?? 0) && res.variables.length > 0) {
      const more = this.el('li', 'dbgnb-more');
      more.textContent = `… ${(v.indexedVariables ?? 0) - next} more`;
      more.onclick = () => {
        more.remove();
        void this.loadPage(into, v, next);
      };
      into.appendChild(more);
    }
  }
}

function classify(v: VariableNode): string {
  const t = (v.type ?? '').toLowerCase();
  const val = v.value;
  if (t === 'str' || t === 'string' || /^['"`]/.test(val)) {
    return 'string';
  }
  if (t === 'int' || t === 'float' || t === 'number' || /^-?\d/.test(val)) {
    return 'number';
  }
  if (t === 'bool' || t === 'boolean' || val === 'True' || val === 'False' || val === 'true' || val === 'false') {
    return 'boolean';
  }
  return '';
}
