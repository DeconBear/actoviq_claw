export interface ParsedCommand {
  name: string;
  args: string[];
  raw: string;
}

export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;

    if (char === '\\' && index + 1 < input.length) {
      current += input[index + 1]!;
      index += 1;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

export function parseCommand(input: string): ParsedCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return undefined;
  }

  const tokens = tokenizeCommand(trimmed.slice(1));
  if (tokens.length === 0) {
    return undefined;
  }

  return {
    name: tokens[0]!.toLowerCase(),
    args: tokens.slice(1),
    raw: trimmed,
  };
}
