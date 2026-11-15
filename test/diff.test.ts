import assert from "node:assert/strict";
import { test } from "node:test";
import { diffJson } from "../src/domain/diff.ts";

test("a value compared with itself has no changes", () => {
  const value = { account: { label: "Main" }, counts: [1, 2], note: null };
  assert.deepEqual(diffJson(value, value), []);
});

test("one changed field is one change and an added field is a change from null", () => {
  assert.deepEqual(diffJson({ label: "Main", open: 1 }, { label: "Other", open: 1 }), [{ path: "/label", before: "Main", after: "Other" }]);
  assert.deepEqual(diffJson({ label: "Main" }, { label: "Main", open: 2 }), [{ path: "/open", before: null, after: 2 }]);
});
