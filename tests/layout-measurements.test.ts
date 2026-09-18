import test from "node:test";
import assert from "node:assert/strict";
import { formatLength, parseLength } from "../src/lib/layout-measurements.ts";

test("formats field dimensions to eighth-inch precision", () => {
  assert.equal(formatLength(37.5), "3′ 1 1/2″");
  assert.equal(formatLength(12.125), "1′ 0 1/8″");
});

test("parses bare mixed fractions as inches", () => {
  assert.equal(parseLength("37 1/2"), 37.5);
  assert.equal(parseLength("1/8"), 0.125);
});

test("parses feet inches and jobsite fraction notation", () => {
  assert.equal(parseLength("3' 1 1/2\""), 37.5);
  assert.equal(parseLength("3 ft 1-1/2 in"), 37.5);
});

test("parses decimal inches", () => {
  assert.equal(parseLength("37.5"), 37.5);
});

test("rejects invalid or zero-denominator fractions", () => {
  assert.equal(parseLength("abc"), null);
  assert.equal(parseLength("12 1/0"), null);
});
