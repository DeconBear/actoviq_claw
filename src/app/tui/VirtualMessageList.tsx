import type React from 'react';

import { useMemo } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';

export interface DisplayLine {
  key: string;
  text: string;
  color?: string;
  backgroundColor?: string;
  dimColor?: boolean;
  bold?: boolean;
  prefixText?: string;
  prefixColor?: string;
  prefixBackgroundColor?: string;
  prefixDimColor?: boolean;
}

export interface TranscriptBlock {
  id: string;
  role: 'user' | 'assistant';
  lines: DisplayLine[];
  contentStartRow: number;
  stickyLabel?: string;
}

export interface TranscriptLayout {
  blocks: TranscriptBlock[];
  heights: number[];
  offsets: number[];
  totalHeight: number;
}

export interface VirtualScrollState {
  scrollTop: number;
  maxScroll: number;
  range: readonly [number, number];
  localOffset: number;
}

const OVERSCAN_ROWS = 10;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function findStartIndex(offsets: readonly number[], target: number): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 2);

  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (offsets[mid]! <= target) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return low;
}

function findEndIndex(offsets: readonly number[], target: number): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 1);

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid]! < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function fitLine(text: string, width: number): string {
  const safeWidth = Math.max(0, width);
  if (safeWidth === 0) {
    return '';
  }

  if (stringWidth(text) <= safeWidth) {
    return `${text}${' '.repeat(Math.max(0, safeWidth - stringWidth(text)))}`;
  }

  let result = '';
  for (const character of text) {
    const next = `${result}${character}`;
    if (stringWidth(next) > safeWidth) {
      break;
    }
    result = next;
  }
  return result;
}

function buildScrollbar(
  totalHeight: number,
  viewportHeight: number,
  scrollTop: number,
): string[] {
  if (viewportHeight <= 0) {
    return [];
  }
  if (totalHeight <= viewportHeight) {
    return Array.from({ length: viewportHeight }, () => ' ');
  }

  const maxScroll = Math.max(1, totalHeight - viewportHeight);
  const handleSize = Math.max(1, Math.round((viewportHeight * viewportHeight) / totalHeight));
  const maxHandleStart = Math.max(0, viewportHeight - handleSize);
  const handleStart = Math.round((scrollTop / maxScroll) * maxHandleStart);

  return Array.from({ length: viewportHeight }, (_, row) =>
    row >= handleStart && row < handleStart + handleSize ? '#' : '|',
  );
}

export function useTranscriptLayout(blocks: TranscriptBlock[]): TranscriptLayout {
  return useMemo(() => {
    const heights = blocks.map(block => block.lines.length);
    const offsets: number[] = [0];

    for (const height of heights) {
      offsets.push(offsets[offsets.length - 1]! + height);
    }

    return {
      blocks,
      heights,
      offsets,
      totalHeight: offsets[offsets.length - 1] ?? 0,
    };
  }, [blocks]);
}

export function useVirtualScroll(
  layout: TranscriptLayout,
  viewportHeight: number,
  requestedScrollTop: number,
): VirtualScrollState {
  return useMemo(() => {
    const maxScroll = Math.max(0, layout.totalHeight - viewportHeight);
    const scrollTop = clamp(requestedScrollTop, 0, maxScroll);
    const overscanStart = Math.max(0, scrollTop - OVERSCAN_ROWS);
    const overscanEnd = Math.min(layout.totalHeight, scrollTop + viewportHeight + OVERSCAN_ROWS);
    const start = layout.blocks.length === 0 ? 0 : findStartIndex(layout.offsets, overscanStart);
    const rawEnd = layout.blocks.length === 0 ? 0 : findEndIndex(layout.offsets, overscanEnd);
    const end = Math.max(start, Math.min(layout.blocks.length, rawEnd + 1));
    const localOffset = scrollTop - (layout.offsets[start] ?? 0);

    return {
      scrollTop,
      maxScroll,
      range: [start, end] as const,
      localOffset,
    };
  }, [layout, requestedScrollTop, viewportHeight]);
}

export function findStickyPrompt(
  layout: TranscriptLayout,
  scrollTop: number,
): string | undefined {
  if (scrollTop <= 0) {
    return undefined;
  }

  for (let index = layout.blocks.length - 1; index >= 0; index -= 1) {
    const block = layout.blocks[index]!;
    if (block.role !== 'user' || !block.stickyLabel) {
      continue;
    }

    const row = (layout.offsets[index] ?? 0) + block.contentStartRow;
    if (row < scrollTop) {
      return block.stickyLabel;
    }
  }

  return undefined;
}

export function VirtualMessageList(props: {
  layout: TranscriptLayout;
  scroll: VirtualScrollState;
  height: number;
  width: number;
}): React.ReactNode {
  const visibleLines = useMemo(() => {
    const [start, end] = props.scroll.range;
    const pool: DisplayLine[] = [];

    for (let index = start; index < end; index += 1) {
      pool.push(...(props.layout.blocks[index]?.lines ?? []));
    }

    const windowed = pool.slice(props.scroll.localOffset, props.scroll.localOffset + props.height);

    while (windowed.length < props.height) {
      windowed.push({
        key: `blank:${windowed.length}`,
        text: '',
        dimColor: true,
      });
    }

    return windowed;
  }, [props.height, props.layout.blocks, props.scroll.localOffset, props.scroll.range]);

  const scrollbar = useMemo(
    () => buildScrollbar(props.layout.totalHeight, props.height, props.scroll.scrollTop),
    [props.height, props.layout.totalHeight, props.scroll.scrollTop],
  );
  const contentWidth = Math.max(4, props.width - 1);

  return (
    <Box flexDirection="column" height={props.height}>
      {visibleLines.map((line, index) => (
        <Box key={line.key}>
          {line.prefixText ? (
            <>
              <Text
                color={line.prefixColor}
                backgroundColor={line.prefixBackgroundColor}
                dimColor={line.prefixDimColor}
                bold={line.bold}
              >
                {line.prefixText}
              </Text>
              <Text
                color={line.color}
                backgroundColor={line.backgroundColor}
                dimColor={line.dimColor}
                bold={line.bold}
              >
                {fitLine(line.text || ' ', Math.max(0, contentWidth - stringWidth(line.prefixText)))}
              </Text>
            </>
          ) : (
            <Text
              color={line.color}
              backgroundColor={line.backgroundColor}
              dimColor={line.dimColor}
              bold={line.bold}
            >
              {fitLine(line.text || ' ', contentWidth)}
            </Text>
          )}
          <Text dimColor={scrollbar[index] !== '#'} color={scrollbar[index] === '#' ? 'cyan' : 'gray'}>
            {scrollbar[index] ?? ' '}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
