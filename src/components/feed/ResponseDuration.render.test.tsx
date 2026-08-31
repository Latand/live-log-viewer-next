import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ResponseDuration } from "./ResponseDuration";

test("a completed response renders its permanent total", () => {
  const html = renderToStaticMarkup(<ResponseDuration durationMs={(4 * 60 + 32) * 1000} />);
  expect(html).toContain("data-response-duration");
  expect(html).toContain("Worked for 4m 32s");
});
