import { expect, test } from "bun:test";

import { admittedMessageTextForms } from "./admittedMessageText";
import { structuredContentDigest } from "./structuredContent";

test("a text admission cannot have altered is its own only form", () => {
  expect(admittedMessageTextForms("fixture report")).toEqual(["fixture report"]);
  expect(admittedMessageTextForms("")).toEqual([""]);
});

test("surrounding whitespace yields the trimmed form first and the verbatim form after it", () => {
  /* Trimmed first because structured admission is what the send route reaches
     for; the verbatim form is kept because the legacy path on that same route
     reserves the text as it arrived. */
  expect(admittedMessageTextForms("fixture report\n")).toEqual(["fixture report", "fixture report\n"]);
  expect(admittedMessageTextForms("\n  fixture report  \n")).toEqual(["fixture report", "\n  fixture report  \n"]);
});

test("whitespace INSIDE the message is payload, so it is never normalized away", () => {
  expect(admittedMessageTextForms("first line\n\nsecond line\n"))
    .toEqual(["first line\n\nsecond line", "first line\n\nsecond line\n"]);
  const forms = admittedMessageTextForms("one  two");
  expect(forms).toEqual(["one  two"]);
  expect(forms.map((text) => structuredContentDigest({ text, images: [] })))
    .not.toContain(structuredContentDigest({ text: "one two", images: [] }));
});
