import Handlebars from "handlebars";

export async function main(
  template: string,
  context: Record<string, unknown>,
): Promise<string> {
  return Handlebars.compile(template, {
    strict: true,
    noEscape: true,
  })(context);
}