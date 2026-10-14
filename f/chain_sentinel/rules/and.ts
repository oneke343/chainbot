export function main(...args: any[]): boolean {
  return args.every((v) => !!v);
}