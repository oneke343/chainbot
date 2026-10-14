export function or(...args: any[]): boolean {
  return args.some((v) => !!v);
}