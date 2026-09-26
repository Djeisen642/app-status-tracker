/**
 * The "Add a status page" form in the panel's footer: the form itself, and
 * nothing about what adding means (that is `WatchList.add`).
 */

export type MessageTone = 'info' | 'error' | 'success';

export class AddForm {
  /** Raised synchronously: a second Enter mustn't start a second check. */
  private busy = false;

  constructor(
    private readonly elements: {
      readonly open: HTMLButtonElement;
      readonly form: HTMLFormElement;
      readonly input: HTMLInputElement;
      readonly submit: HTMLButtonElement;
      readonly cancel: HTMLButtonElement;
      readonly message: HTMLElement;
    },
    /** Runs the add. Resolves with what to tell the user, and whether it worked. */
    private readonly onSubmit: (
      input: string,
      say: (text: string, tone: MessageTone) => void,
    ) => Promise<boolean>,
  ) {
    elements.open.addEventListener('click', () => {
      this.open();
    });
    elements.cancel.addEventListener('click', () => {
      this.close();
    });
    elements.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });
  }

  get isOpen(): boolean {
    return !this.elements.form.hidden;
  }

  open(): void {
    this.elements.form.hidden = false;
    this.elements.open.hidden = true;
    this.say('', 'info');
    this.elements.input.focus();
  }

  close(): void {
    this.elements.form.hidden = true;
    this.elements.open.hidden = false;
    this.elements.input.value = '';
    this.say('', 'info');
    this.elements.open.focus();
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.elements.submit.disabled = true;
    try {
      const added = await this.onSubmit(this.elements.input.value, (text, tone) => {
        this.say(text, tone);
      });
      if (added) this.elements.input.value = '';
    } finally {
      this.busy = false;
      this.elements.submit.disabled = false;
    }
  }

  private say(text: string, tone: MessageTone): void {
    this.elements.message.textContent = text;
    this.elements.message.dataset.tone = tone;
  }
}
