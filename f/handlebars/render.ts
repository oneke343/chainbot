import Handlebars from "handlebars";

export async function main(
  template: string,
  context: Record<string, unknown>,
): Promise<string> {
  const handlebars = Handlebars.create();
  handlebars.registerHelper(
    "eq",
    (left: unknown, right: unknown) => left === right,
  );
  return handlebars.compile(template, {
    strict: true,
    noEscape: true,
  })(context);
}
