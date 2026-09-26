/**
 * The service rows, updated in place.
 *
 * Rebuilding them every round (every 5 to 30 seconds) threw away keyboard
 * focus mid-Tab, and dropped a click whose press and release straddled a
 * rebuild. So each service gets its elements once and only their contents
 * change; a row is moved only when the order actually changed, because moving
 * a node blurs it. Handlers carry the service's id, never a stale object.
 */

import type { RowView } from '../lib/services.ts';

export interface RowModel {
  readonly id: string;
  readonly name: string;
  readonly pageUrl: string;
  readonly view: RowView;
}

export interface RowActions {
  open(id: string): void;
  remove(id: string): void;
}

interface Row {
  readonly item: HTMLLIElement;
  readonly button: HTMLButtonElement;
  readonly name: HTMLSpanElement;
  readonly subtitle: HTMLSpanElement;
  readonly label: HTMLSpanElement;
  readonly remove: HTMLButtonElement;
}

export class ServiceList {
  private readonly rows = new Map<string, Row>();

  constructor(
    private readonly list: HTMLUListElement,
    private readonly actions: RowActions,
  ) {}

  render(models: readonly RowModel[]): void {
    const ids = new Set(models.map((model) => model.id));
    for (const [id, row] of this.rows) {
      if (ids.has(id)) continue;
      row.item.remove();
      this.rows.delete(id);
    }

    models.forEach((model, index) => {
      let row = this.rows.get(model.id);
      if (row === undefined) {
        row = this.create(model.id);
        this.rows.set(model.id, row);
      }
      update(row, model);
      if (this.list.children[index] !== row.item) {
        this.list.insertBefore(row.item, this.list.children[index] ?? null);
      }
    });
  }

  private create(id: string): Row {
    const item = document.createElement('li');
    item.className = 'service-item';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'row service-row';
    button.dataset.service = id;
    button.addEventListener('click', () => {
      this.actions.open(id);
    });

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.className = 'row-text';
    const name = document.createElement('span');
    name.className = 'row-name';
    const subtitle = document.createElement('span');
    subtitle.className = 'row-subtitle';
    text.append(name, subtitle);

    const label = document.createElement('span');
    label.className = 'row-level pill';
    button.append(dot, text, label);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-button service-remove';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      this.actions.remove(id);
    });

    item.append(button, remove);
    return { item, button, name, subtitle, label, remove };
  }
}

/** Everything in a row that can change. Network text: `textContent` only. */
function update(row: Row, model: RowModel): void {
  const { view } = model;
  row.button.dataset.state = view.state;
  row.button.title = `Open ${model.pageUrl}`;
  row.name.textContent = model.name;
  row.subtitle.textContent = view.subtitle ?? '';
  row.subtitle.hidden = view.subtitle === null;
  row.label.textContent = view.label;
  row.remove.setAttribute('aria-label', `Stop watching ${model.name}`);
  row.remove.title = `Stop watching ${model.name}`;
}
