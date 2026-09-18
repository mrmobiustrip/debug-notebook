/**
 * Minimal stand-in for the `vscode` module so units can run under vitest.
 * Only the surface the units touch is implemented.
 */

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => unknown>();
  readonly event = (listener: (e: T) => unknown): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) {
      l(e);
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export interface Disposable {
  dispose(): unknown;
}

export enum NotebookCellKind {
  Markup = 1,
  Code = 2,
}

export enum NotebookCellStatusBarAlignment {
  Left = 1,
  Right = 2,
}

const enc = new TextEncoder();

export class NotebookCellOutputItem {
  constructor(public data: Uint8Array, public mime: string) {}
  static text(value: string, mime = 'text/plain'): NotebookCellOutputItem {
    return new NotebookCellOutputItem(enc.encode(value), mime);
  }
  static json(value: unknown, mime = 'text/x-json'): NotebookCellOutputItem {
    return new NotebookCellOutputItem(enc.encode(JSON.stringify(value)), mime);
  }
  static stdout(value: string): NotebookCellOutputItem {
    return new NotebookCellOutputItem(enc.encode(value), 'application/vnd.code.notebook.stdout');
  }
  static stderr(value: string): NotebookCellOutputItem {
    return new NotebookCellOutputItem(enc.encode(value), 'application/vnd.code.notebook.stderr');
  }
  static error(value: { name: string; message: string; stack?: string }): NotebookCellOutputItem {
    return new NotebookCellOutputItem(enc.encode(JSON.stringify(value)), 'application/vnd.code.notebook.error');
  }
}

export class NotebookCellOutput {
  metadata?: Record<string, unknown>;
  constructor(public items: NotebookCellOutputItem[], metadata?: Record<string, unknown>) {
    this.metadata = metadata;
  }
}

export class NotebookCellData {
  metadata?: Record<string, unknown>;
  outputs?: NotebookCellOutput[];
  executionSummary?: { executionOrder?: number };
  constructor(public kind: NotebookCellKind, public value: string, public languageId: string) {}
}

export class NotebookData {
  metadata?: Record<string, unknown>;
  constructor(public cells: NotebookCellData[]) {}
}

export class NotebookCellStatusBarItem {
  tooltip?: string;
  command?: string;
  constructor(public text: string, public alignment: NotebookCellStatusBarAlignment) {}
}

export class CancellationTokenSource {
  private cancelled = false;
  private emitter = new EventEmitter<void>();
  readonly token = {
    get isCancellationRequested(): boolean {
      return false;
    },
    onCancellationRequested: this.emitter.event,
  };
  cancel(): void {
    this.cancelled = true;
    Object.defineProperty(this.token, 'isCancellationRequested', { value: true });
    this.emitter.fire();
  }
  dispose(): void {
    this.emitter.dispose();
  }
  get isCancelled(): boolean {
    return this.cancelled;
  }
}

// `debug` is stubbed so SessionRegistry can construct in tests. Tests drive the
// tracker directly through the captured factory.
export const debug = {
  activeDebugSession: undefined as unknown,
  activeStackItem: undefined as unknown,
  trackerFactory: undefined as undefined | { createDebugAdapterTracker(session: unknown): unknown },
  terminateListeners: [] as Array<(s: unknown) => void>,
  registerDebugAdapterTrackerFactory(_type: string, factory: { createDebugAdapterTracker(session: unknown): unknown }): Disposable {
    debug.trackerFactory = factory;
    return { dispose: () => undefined };
  },
  onDidTerminateDebugSession(listener: (s: unknown) => void): Disposable {
    debug.terminateListeners.push(listener);
    return { dispose: () => undefined };
  },
};

export const notebooks = {
  registerNotebookCellStatusBarItemProvider(): Disposable {
    return { dispose: () => undefined };
  },
};

export const workspace = {
  getConfiguration() {
    return { get: <T>(_k: string, d: T) => d };
  },
};
