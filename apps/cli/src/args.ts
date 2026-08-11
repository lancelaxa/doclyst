/**
 * Argument parsing.
 *
 * Hand-rolled rather than pulled from a dependency: the surface is a handful
 * of flags, and keeping the dependency list near-empty is a meaningful part of
 * the trust story for a tool that handles personal data on someone's machine.
 */

export interface ParsedArgs {
  readonly command: string | undefined;
  readonly flags: ReadonlyMap<string, string | boolean>;
  readonly positionals: readonly string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  let command: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;

    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const equals = body.indexOf('=');
      if (equals >= 0) {
        flags.set(body.slice(0, equals), body.slice(equals + 1));
        continue;
      }
      const next = argv[i + 1];
      // `--flag value` only consumes the next token when it is not itself a
      // flag, so boolean flags can be written bare.
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(body, next);
        i += 1;
      } else {
        flags.set(body, true);
      }
      continue;
    }

    if (command === undefined) command = arg;
    else positionals.push(arg);
  }

  return { command, flags, positionals };
}

export function getString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function getBoolean(args: ParsedArgs, name: string): boolean {
  const value = args.flags.get(name);
  if (value === true) return true;
  if (typeof value === 'string') return value !== 'false' && value !== '0';
  return false;
}
