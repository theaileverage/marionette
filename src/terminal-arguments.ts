import { AppError } from './types.js';

/** Herdr sends one shell input line. Leave room below macOS's 1024-byte TTY limit. */
export function validateTerminalArguments(kind: string, args: string[]) {
  if (args.some((arg) => /\p{Cc}/u.test(arg)))
    throw new AppError({
      code: 'lead_arguments',
      message:
        'Launch arguments contain control characters unsupported by Herdr. Check the selected model profile and project settings.',
      status: 400,
    });
  // Conservatively quote every argument, including ordinary words.
  const command = [kind, ...args].map((arg) => "'" + arg.replace(/'/g, "'\\''") + "'").join(' ');
  if (Buffer.byteLength(command, 'utf8') > 1000)
    throw new AppError({
      code: 'terminal_arguments_too_long',
      message:
        'Agent launch exceeds the safe terminal input size. Use a shorter Marionette --home path or shorter custom profile arguments, then run setup again. No launch command was sent.',
      status: 400,
    });
}
