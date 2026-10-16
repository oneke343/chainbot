import Handlebars from "handlebars";

function formatNumber(value: number, maximumFractionDigits: number): string {
  if (value !== 0 && Math.abs(value) < 10 ** -maximumFractionDigits)
    return value.toExponential(2);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(
    value,
  );
}

export async function main(
  template: string,
  context: Record<string, unknown>,
): Promise<string> {
  const handlebars = Handlebars.create();
  handlebars.registerHelper(
    "eq",
    (left: unknown, right: unknown) => left === right,
  );
  handlebars.registerHelper("number", (value: string | number) =>
    formatNumber(Number(value), 4),
  );
  handlebars.registerHelper(
    "percent",
    (value: string | number) => `${formatNumber(Number(value) * 100, 2)}%`,
  );
  handlebars.registerHelper(
    "pp",
    (value: string | number) => `${formatNumber(Number(value) * 100, 2)} pp`,
  );
  return handlebars.compile(template, {
    strict: true,
    noEscape: true,
  })(context);
}
