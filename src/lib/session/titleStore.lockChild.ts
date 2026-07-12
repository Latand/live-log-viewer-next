/* Child process for titleStore.interprocess.test.ts. Writes `count` distinct
   keys through the locked mutation so the parent can assert no update was lost
   to a cross-process read-modify-write race. Not a test itself. */
import { writeSessionTitle } from "./titleStore";

const writer = process.argv[2] ?? "0";
const count = Number(process.argv[3] ?? "0");

for (let index = 0; index < count; index += 1) {
  const key = `path:/w${writer}/${index}`;
  writeSessionTitle([key], key, `title-${writer}-${index}`, undefined, `2026-07-12T00:00:00.${String(index).padStart(3, "0")}Z`);
}
