/**
 * The Settings overlay: build info today, the future home of everything
 * `docs/future-work.md` phase 3 lists (component filters, launch at login).
 * Slides over the panel's content rather than opening a second window (see
 * CLAUDE.md's "Settings will be an overlay in the one window").
 */

export class Settings {
  constructor(
    private readonly elements: {
      readonly open: HTMLButtonElement;
      readonly overlay: HTMLElement;
      readonly close: HTMLButtonElement;
      readonly buildInfo: HTMLElement;
      /** Everything the overlay covers, made `inert` while it's open. */
      readonly content: HTMLElement;
    },
    buildInfo: string,
  ) {
    elements.buildInfo.textContent = buildInfo;
    elements.open.addEventListener('click', () => {
      this.open();
    });
    elements.close.addEventListener('click', () => {
      this.close();
    });
  }

  get isOpen(): boolean {
    return !this.elements.overlay.hidden;
  }

  open(): void {
    this.elements.overlay.hidden = false;
    // Without this, Tab still reaches the close button, the add form and
    // every row underneath the sheet: covered, but not actually gone.
    this.elements.content.setAttribute('inert', '');
    this.elements.close.focus();
  }

  close(): void {
    this.elements.overlay.hidden = true;
    this.elements.content.removeAttribute('inert');
    this.elements.open.focus();
  }
}
