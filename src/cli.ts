export async function main(argv: string[]): Promise<void> {
  const cmd = argv[0] ?? 'help';
  process.stderr.write(`claude-usage: subcommand "${cmd}" not implemented yet\n`);
  process.exitCode = 1;
}
