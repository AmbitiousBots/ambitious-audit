import { Ajv2020 } from "ajv/dist/2020.js";

export const wholeCents = (value: number): boolean => Number(value.toFixed(2)) === value;

export const wireValidator = new Ajv2020({ allErrors: true, strict: true, verbose: true });

// WHY: Dividing a JSON number such as 0.29 by 0.01 can reject valid cents. Decimal rounding also rejects fractions smaller than a tolerance.
wireValidator.removeKeyword("multipleOf").addKeyword({
  keyword: "multipleOf",
  type: "number",
  schemaType: "number",
  validate: (step: number, value: number): boolean => step === 0.01 ? wholeCents(value) : Number.isInteger(value / step),
  errors: false,
});
