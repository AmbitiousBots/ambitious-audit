import { Ajv2020 } from "ajv/dist/2020.js";

export const wholeCents = (value: number): boolean => Number(value.toFixed(2)) === value;

export const wireValidator = new Ajv2020({ allErrors: true, strict: true, verbose: true });
