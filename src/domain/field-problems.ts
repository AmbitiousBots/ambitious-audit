import { Failure } from "@ambitious/kit/domain/failure";
import type { ErrorEntry } from "@ambitious/kit/domain/envelope";

export type FieldProblem = {
  readonly pointer: string;
  readonly rule: string;
  readonly must: string;
  readonly help: string;
};

const SHOWN = 8;

export const pointerOf = (parts: readonly (string | number)[]): string =>
  parts.map((part) => `/${String(part).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");

const entryOf = (problem: FieldProblem, schemaCommand: string): ErrorEntry => ({
  code: "E_INPUT_SCHEMA",
  message: `The input ${problem.pointer === "" ? "document" : `field ${problem.pointer}`} ${problem.must} (rule: ${problem.rule}).`,
  hint: `${problem.help === "" ? "" : `${problem.help} `}Run "ambitious-audit ${schemaCommand}" to print the schema for this input.`,
});

const UNEXPLAINED: FieldProblem = { pointer: "", rule: "schema", must: "does not match its schema", help: "" };

export const inputFailure = (schemaCommand: string, problems: readonly FieldProblem[]): Failure => {
  const [first = UNEXPLAINED, ...rest] = problems;
  return new Failure([entryOf(first, schemaCommand), ...rest.slice(0, SHOWN - 1).map((problem) => entryOf(problem, schemaCommand))], {
    fields: [first, ...rest].slice(0, 50).map((problem) => ({ pointer: problem.pointer, rule: problem.rule })),
  });
};

export const refuseProblems = (schemaCommand: string, problems: readonly FieldProblem[]): void => {
  if (problems.length > 0) throw inputFailure(schemaCommand, problems);
};
