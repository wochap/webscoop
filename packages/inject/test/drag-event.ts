// jsdom has no DragEvent, so drag events lose `clientX`, `clientY`, and `relatedTarget`; a MouseEvent based one keeps them.
if (typeof window !== 'undefined' && !('DragEvent' in window)) {
  class DragEvent extends MouseEvent {
    readonly dataTransfer: DataTransfer | null;
    constructor(type: string, init: MouseEventInit & { dataTransfer?: DataTransfer | null } = {}) {
      super(type, init);
      this.dataTransfer = init.dataTransfer ?? null;
    }
  }
  Object.assign(window, { DragEvent });
}
