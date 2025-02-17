import { GristDoc } from "app/client/components/GristDoc";
import { KoArray, syncedKoArray } from "app/client/lib/koArray";
import * as kf from 'app/client/lib/koForm';
import * as tableUtil from 'app/client/lib/tableUtil';
import { ColumnRec, ViewFieldRec, ViewSectionRec } from "app/client/models/DocModel";
import { getFieldType } from "app/client/ui/RightPanel";
import { IWidgetType } from "app/client/ui/widgetTypes";
import { basicButton, cssButton, primaryButton } from 'app/client/ui2018/buttons';
import * as checkbox from "app/client/ui2018/checkbox";
import { colors, vars } from "app/client/ui2018/cssVars";
import { cssDragger } from "app/client/ui2018/draggableList";
import { icon } from "app/client/ui2018/icons";
import * as gutil from 'app/common/gutil';
import { Computed, Disposable, dom, IDomArgs, makeTestId, Observable, styled } from "grainjs";
import difference = require("lodash/difference");

const testId = makeTestId('test-vfc-');

type IField = ViewFieldRec|ColumnRec;

interface DraggableFieldsOption {
  // an object holding options for the draggable list, see koForm.js for more detail on the accepted
  // options.
  draggableOptions: any;

  // the itemCreateFunc callback passed to kf.draggableList for the visible fields.
  itemCreateFunc(field: IField): Element|undefined;
}

/**
 * VisibleFieldsConfig builds dom for the visible/hidden fields configuration component. Usage is:
 *
 *   dom.create(VisibleFieldsConfig, gristDoc, section);
 *
 * Can also be used to build the two draggable list only:
 *
 *   const config = VisibleFieldsConfig.create(null, gristDoc, section);
 *   const [visibleFieldsDraggable, hiddenFieldsDraggable] =
 *     config.buildSectionFieldsConfigHelper({visibleFields: {itemCreateFunc: getLabelFunc},
 *                                            hiddenFields: {itemCreateFunc: getLabelFunc}});
 *
 * The later for is useful to support old ui, refer to function's doc for more detail on the
 * available options.
 */
export class VisibleFieldsConfig extends Disposable {

  private _hiddenFields: KoArray<ColumnRec> = this.autoDispose(syncedKoArray(this._section.hiddenColumns));

  private _fieldLabel = Computed.create(this, (use) => {
    const widgetType = use(this._section.parentKey) as IWidgetType;
    return getFieldType(widgetType).pluralLabel;
  });

  private _collapseHiddenFields = Observable.create(this, false);

  /**
   * Set if and only if the corresponding selection is empty, ie: respectively
   * visibleFieldsSelection and hiddenFieldsSelection.
   */
  private _showVisibleBatchButtons = Observable.create(this, false);
  private _showHiddenBatchButtons = Observable.create(this, false);

  private _visibleFieldsSelection = new Set<number>();
  private _hiddenFieldsSelection = new Set<number>();

  constructor(private _gristDoc: GristDoc,
              private _section: ViewSectionRec,
              private _useNewUI: boolean = false) {
    super();

    // Unselects visible fields that are hidden.
    this.autoDispose(this._section.viewFields.peek().subscribe((ev) => {
      unselectDeletedFields(this._visibleFieldsSelection, ev);
      this._showVisibleBatchButtons.set(Boolean(this._visibleFieldsSelection.size));
    }, null, 'spliceChange'));

    // Unselectes hidden fields that are shown.
    this.autoDispose(this._hiddenFields.subscribe((ev) => {
      unselectDeletedFields(this._hiddenFieldsSelection, ev);
      this._showHiddenBatchButtons.set(Boolean(this._hiddenFieldsSelection.size));
    }, null, 'spliceChange'));
  }

  /**
   * Build the two draggable list components to show both the visible and the hidden fields of a
   * section. Each draggable list can be parametrized using both `options.visibleFields` and
   * `options.hiddenFields` options.
   *
   * @param {DraggableFieldOption} options.hiddenFields options for the list of hidden fields.
   * @param {DraggableFieldOption} options.visibleFields options for the list of visible fields.
   * @return {[Element, Element]} the two draggable elements (ie: koForm.draggableList) showing
   *                              respectivelly the list of visible fields and the list of hidden
   *                              fields of section.
   */
  public buildSectionFieldsConfigHelper(
    options: {
      visibleFields: DraggableFieldsOption,
      hiddenFields: DraggableFieldsOption,
    }): [HTMLElement, HTMLElement] {

    const itemClass = this._useNewUI ? cssDragRow.className : 'view_config_draggable_field';
    const fieldsDraggable = dom.update(
      kf.draggableList(
        this._section.viewFields.peek(),
        options.visibleFields.itemCreateFunc,
        {
          itemClass,
          reorder: this._changeFieldPosition.bind(this),
          remove: this._removeField.bind(this),
          receive: this._addField.bind(this),
          ...options.visibleFields.draggableOptions,
        }
      ),
    );
    const hiddenFieldsDraggable = kf.draggableList(
      this._hiddenFields,
      options.hiddenFields.itemCreateFunc,
      {
        itemClass,
        reorder() { throw new Error('Hidden Fields cannot be reordered'); },
        receive() { throw new Error('Cannot drop items into Hidden Fields'); },
        remove(item: ColumnRec) {
          // Return the column object. This value is passed to the viewFields
          // receive function as its respective item parameter
          return item;
        },
        removeButton: false,
        ...options.hiddenFields.draggableOptions,
      }
    );
    kf.connectDraggableOneWay(hiddenFieldsDraggable, fieldsDraggable);
    return [fieldsDraggable, hiddenFieldsDraggable];
  }

  public buildDom() {

    const [fieldsDraggable, hiddenFieldsDraggable] = this.buildSectionFieldsConfigHelper({
      visibleFields: {
        itemCreateFunc: (field) => this._buildVisibleFieldItem(field as ViewFieldRec),
        draggableOptions: {
          removeButton: false,
          drag_indicator: cssDragger,
        }
      },
      hiddenFields: {
        itemCreateFunc: (field) => this._buildHiddenFieldItem(field as ColumnRec),
        draggableOptions: {
          removeButton: false,
          drag_indicator: cssDragger,
        },
      },
    });
    return [
      cssHeader(
        cssFieldListHeader(dom.text((use) => `Visible ${use(this._fieldLabel)}`)),
        dom.maybe(
          (use) => Boolean(use(use(this._section.viewFields).getObservable()).length),
          () => (
            cssGreenLabel(
              icon('Tick'),
              'Select All',
              dom.on('click', () => this._setVisibleCheckboxes(fieldsDraggable, true)),
              testId('visible-fields-select-all'),
            )
          )
        ),
      ),
      dom.update(fieldsDraggable, testId('visible-fields')),
      dom.maybe(this._showVisibleBatchButtons, () =>
        cssRow(
          primaryButton(
            dom.text((use) => `Hide ${use(this._fieldLabel)}`),
            dom.on('click', () => this._removeSelectedFields()),
          ),
          basicButton(
            'Clear',
            dom.on('click', () => this._setVisibleCheckboxes(fieldsDraggable, false)),
          ),
          testId('visible-batch-buttons')
        ),
      ),
      cssHeader(
        cssHeaderIcon(
          'Dropdown',
          dom.style('transform', (use) => use(this._collapseHiddenFields) ? 'rotate(-90deg)' : ''),
          dom.style('cursor', 'pointer'),
          dom.on('click', () => this._collapseHiddenFields.set(!this._collapseHiddenFields.get())),
          testId('collapse-hidden'),
        ),
        // TODO: show `hidden column` only when some fields are hidden
        cssFieldListHeader(dom.text((use) => `Hidden ${use(this._fieldLabel)}`)),
        dom.maybe(
          (use) => Boolean(use(this._hiddenFields.getObservable()).length && !use(this._collapseHiddenFields)),
          () => (
            cssGreenLabel(
              icon('Tick'),
              'Select All',
              dom.on('click', () => this._setHiddenCheckboxes(hiddenFieldsDraggable, true)),
              testId('hidden-fields-select-all'),
            )
          )
        ),
      ),
      dom(
        'div',
        dom.hide(this._collapseHiddenFields),
        dom.update(
          hiddenFieldsDraggable,
          testId('hidden-fields'),
        ),
        dom.maybe(this._showHiddenBatchButtons, () =>
          cssRow(
            primaryButton(
              dom.text((use) => `Show ${use(this._fieldLabel)}`),
              dom.on('click', () => this._addSelectedFields()),
            ),
            basicButton(
              'Clear',
              dom.on('click', () => this._setHiddenCheckboxes(hiddenFieldsDraggable, false)),
            ),
            testId('hidden-batch-buttons')
          )
        ),
      ),
    ];
  }

  // Set all checkboxes for the visible fields.
  private _setVisibleCheckboxes(visibleFieldsDraggable: Element, checked: boolean) {
    this._setCheckboxesHelper(
      visibleFieldsDraggable,
      this._section.viewFields.peek().peek(),
      this._visibleFieldsSelection,
      checked
    );
    this._showVisibleBatchButtons.set(checked);

  }

  // Set all checkboxes for the hidden fields.
  private _setHiddenCheckboxes(hiddenFieldsDraggable: Element, checked: boolean) {
    this._setCheckboxesHelper(
      hiddenFieldsDraggable,
      this._hiddenFields.peek(),
      this._hiddenFieldsSelection,
      checked
    );
    this._showHiddenBatchButtons.set(checked);
  }

  // A helper to set all checkboxes. Takes care of setting all checkboxes in the dom and updating
  // the selection.
  private _setCheckboxesHelper(draggable: Element, fields: IField[], selection: Set<number>,
                               checked: boolean) {

    findCheckboxes(draggable).forEach((el) => el.checked = checked);

    selection.clear();

    if (checked) {
      // add all ids to the selection
      fields.forEach((field) => selection.add(field.id.peek()));
    }
  }

  private _buildHiddenFieldItem(column: IField) {
    const id = column.id.peek();
    const selection = this._hiddenFieldsSelection;

    return cssFieldEntry(
      cssFieldLabel(dom.text(column.label)),
      cssHideIcon('EyeShow',
        dom.on('click', () => this._addField(column)),
        testId('hide')
      ),
      buildCheckbox(
        dom.prop('checked', selection.has(id)),
        dom.on('change', (ev, el) => {
          el.checked ? selection.add(id) : selection.delete(id);
          this._showHiddenBatchButtons.set(Boolean(selection.size));
        })
      )
    );
  }

  private _buildVisibleFieldItem(field: IField) {
    const id = field.id.peek();
    const selection = this._visibleFieldsSelection;

    return cssFieldEntry(
      cssFieldLabel(dom.text(field.label)),
      // TODO: we need a "cross-out eye" icon here.
      cssHideIcon('EyeHide',
        dom.on('click', () => this._removeField(field)),
        testId('hide')
      ),
      buildCheckbox(
        dom.prop('checked', selection.has(id)),
        dom.on('change', (ev, el) => {
          el.checked ? selection.add(id) : selection.delete(id);
          this._showVisibleBatchButtons.set(Boolean(selection.size));
        })
      )
    );
  }

  private _changeFieldPosition(field: ViewFieldRec, nextField: ViewFieldRec|null) {
    const parentPos = getFieldNewPosition(this._section.viewFields.peek(), field, nextField);
    const vsfAction = ['UpdateRecord', field.id.peek(), {parentPos} ];
    return this._gristDoc.docModel.viewFields.sendTableAction(vsfAction);
  }

  private async _removeField(field: IField) {
    const id = field.id.peek();
    const action = ['RemoveRecord', id];
    await this._gristDoc.docModel.viewFields.sendTableAction(action);
  }

  private async _removeSelectedFields() {
    const toRemove = Array.from(this._visibleFieldsSelection).sort(gutil.nativeCompare);
    const action = ['BulkRemoveRecord', toRemove];
    await this._gristDoc.docModel.viewFields.sendTableAction(action);
  }

  private async _addField(column: IField, nextField: ViewFieldRec|null = null) {
    const parentPos = getFieldNewPosition(this._section.viewFields.peek(), column, nextField);
    const colInfo = {
      parentId: this._section.id.peek(),
      colRef: column.id.peek(),
      parentPos,
    };
    const action = ['AddRecord', null, colInfo];
    await this._gristDoc.docModel.viewFields.sendTableAction(action);
  }

  private async _addSelectedFields() {
    const toAdd = Array.from(this._hiddenFieldsSelection);
    const rowIds = gutil.arrayRepeat(toAdd.length, null);
    const colInfo = {
      parentId: gutil.arrayRepeat(toAdd.length, this._section.id.peek()),
      colRef: toAdd,
    };
    const action = ['BulkAddRecord', rowIds, colInfo];
    await this._gristDoc.docModel.viewFields.sendTableAction(action);
  }

}

function getFieldNewPosition(fields: KoArray<ViewFieldRec>, item: IField,
                             nextField: ViewFieldRec|null): number {
  const index = getItemIndex(fields, nextField);
  return tableUtil.fieldInsertPositions(fields, index, 1)[0];
}

function getItemIndex(collection: KoArray<ViewFieldRec>, item: ViewFieldRec|null): number {
  if (item !== null) {
    return collection.peek().indexOf(item);
  }
  return collection.peek().length;
}

function buildCheckbox(...args: IDomArgs<HTMLInputElement>) {
  return checkbox.cssLabel(
    {style: 'flex-shrink: 0;'},
    checkbox.cssCheckboxSquare(
      {type: 'checkbox'},
      ...args
    )
  );
}

// helper to find checkboxes withing a draggable list. This assumes that checkboxes are the only
// <input> element in draggableElement.
function findCheckboxes(draggableElement: Element): NodeListOf<HTMLInputElement> {
  return draggableElement.querySelectorAll<HTMLInputElement>('input');
}

// Removes from selection the ids of the fields that appear as deleted in the splice event. Note
// that it can happen that a field appears as deleted and yet belongs to the new array (as a result
// of an `assign` call for instance). In which case the field is to be considered as not deleted.
function unselectDeletedFields(selection: Set<number>, event: {deleted: IField[], array: IField[]}) {
  // go though the difference between deleted fields and the new array.
  const removed: IField[] = difference(event.deleted, event.array);
  for (const field of removed) {
    selection.delete(field.id.peek());
  }
}

const cssDragRow = styled('div', `
  display: flex !important;
  align-items: center;
  margin: 0 16px 0px 0px;
  & > .kf_draggable_content {
    margin: 2px 0;
    flex: 1 1 0px;
    min-width: 0px;
  }
`);

export const cssFieldEntry = styled('div', `
  display: flex;
  background-color: ${colors.mediumGrey};
  width: 100%;
  border-radius: 2px;
  margin: 0 8px 0 0;
  padding: 4px 8px;
  cursor: default;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;

  --icon-color: ${colors.slate};
`);

const cssHideIcon = styled(icon, `
  display: none;
  cursor: pointer;
  flex: none;
  margin-right: 8px;
  .kf_draggable:hover & {
    display: block;
  }
`);

export const cssFieldLabel = styled('span', `
  flex: 1 1 auto;
  text-overflow: ellipsis;
  overflow: hidden;
`);

const cssFieldListHeader = styled('span', `
  flex: 1 1 0px;
  font-size: ${vars.xsmallFontSize};
  text-transform: uppercase;
`);

const cssRow = styled('div', `
  display: flex;
  margin: 16px;
  overflow: hidden;
  --icon-color: ${colors.slate};
  & > .${cssButton.className} {
    margin-right: 8px;
  }
`);

const cssGreenLabel = styled('div', `
  --icon-color: ${colors.lightGreen};
  color: ${colors.lightGreen};
  cursor: pointer;
`);

const cssHeader = styled(cssRow, `
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
`);

const cssHeaderIcon = styled(icon, `
  flex: none;
  margin-right: 4px;
`);
