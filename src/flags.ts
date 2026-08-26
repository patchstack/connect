/** CLI flag map shared by the entry point and the command modules. */
export type Flags = Map<string, string | true>;

export function getStringFlag(flags: Flags, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}
