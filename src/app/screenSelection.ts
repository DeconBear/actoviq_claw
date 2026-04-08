export interface ScreenPoint {
  col: number;
  row: number;
}

export interface ScreenSelectionState {
  anchor: ScreenPoint | null;
  focus: ScreenPoint | null;
  dragging: boolean;
}

export function createScreenSelectionState(): ScreenSelectionState {
  return {
    anchor: null,
    focus: null,
    dragging: false,
  };
}

export function clearScreenSelection(selection: ScreenSelectionState): void {
  selection.anchor = null;
  selection.focus = null;
  selection.dragging = false;
}

export function startScreenSelection(selection: ScreenSelectionState, point: ScreenPoint): void {
  selection.anchor = point;
  selection.focus = null;
  selection.dragging = true;
}

export function updateScreenSelection(selection: ScreenSelectionState, point: ScreenPoint): void {
  if (!selection.dragging || !selection.anchor) {
    return;
  }
  if (selection.anchor.col === point.col && selection.anchor.row === point.row && !selection.focus) {
    return;
  }
  selection.focus = point;
}

export function finishScreenSelection(selection: ScreenSelectionState): void {
  selection.dragging = false;
}

export function hasScreenSelection(selection: ScreenSelectionState): boolean {
  if (!selection.anchor || !selection.focus) {
    return false;
  }
  return selection.anchor.col !== selection.focus.col || selection.anchor.row !== selection.focus.row;
}

function normalizeBounds(selection: ScreenSelectionState): { start: ScreenPoint; end: ScreenPoint } | undefined {
  if (!selection.anchor || !selection.focus) {
    return undefined;
  }

  const anchorBeforeFocus =
    selection.anchor.row < selection.focus.row ||
    (selection.anchor.row === selection.focus.row && selection.anchor.col <= selection.focus.col);

  return anchorBeforeFocus
    ? { start: selection.anchor, end: selection.focus }
    : { start: selection.focus, end: selection.anchor };
}

export function extractSelectedText(lines: readonly string[], selection: ScreenSelectionState): string {
  const bounds = normalizeBounds(selection);
  if (!bounds) {
    return '';
  }

  const { start, end } = bounds;
  const chunks: string[] = [];

  for (let row = start.row; row <= end.row; row += 1) {
    const line = lines[row] ?? '';
    const from = row === start.row ? Math.max(0, start.col) : 0;
    const to = row === end.row ? Math.max(from, end.col + 1) : line.length;
    chunks.push(line.slice(from, to).replace(/\s+$/u, ''));
  }

  return chunks.join('\n').trimEnd();
}
