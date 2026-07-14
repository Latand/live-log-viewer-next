export const runtime = "nodejs";

export function GET(): Response {
  return new Response("ok");
}

export const strayHelper = "breaks next build";
