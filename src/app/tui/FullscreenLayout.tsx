import type React from 'react';

import { Box, Text } from 'ink';
import stringWidth from 'string-width';

function fitInline(text: string | undefined, width: number): string {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  const maxWidth = Math.max(0, width);
  if (stringWidth(normalized) <= maxWidth) {
    return normalized;
  }

  if (maxWidth <= 1) {
    return normalized.slice(0, maxWidth);
  }

  let result = '';
  for (const character of normalized) {
    const next = `${result}${character}`;
    if (stringWidth(`${next}…`) > maxWidth) {
      break;
    }
    result = next;
  }

  return result ? `${result}…` : normalized.slice(0, maxWidth);
}

function StickyPromptHeader(props: {
  text?: string;
  width: number;
}): React.ReactNode {
  const content = fitInline(props.text, Math.max(8, props.width - 6));

  return (
    <Box height={1} paddingX={2}>
      {content ? (
        <Text backgroundColor="gray" color="white">
          {` ${content} `}
        </Text>
      ) : (
        <Text dimColor> </Text>
      )}
    </Box>
  );
}

function NewMessagesPill(props: { label: string }): React.ReactNode {
  return (
    <Box justifyContent="center" paddingX={2}>
      <Text backgroundColor="yellow" color="black">
        {` ${props.label} `}
      </Text>
    </Box>
  );
}

interface FullscreenLayoutProps {
  rows: number;
  width: number;
  headerText?: string;
  scrollable: React.ReactNode;
  modal?: React.ReactNode;
  newMessagesLabel?: string;
  bottom: React.ReactNode;
}

export function FullscreenLayout(props: FullscreenLayoutProps): React.ReactNode {
  return (
    <Box flexDirection="column" height={props.rows}>
      <StickyPromptHeader text={props.headerText} width={props.width} />

      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        {props.scrollable}
      </Box>

      {props.newMessagesLabel ? <NewMessagesPill label={props.newMessagesLabel} /> : null}
      {props.modal}
      <Text dimColor>{'-'.repeat(Math.max(12, props.width))}</Text>
      {props.bottom}
    </Box>
  );
}
