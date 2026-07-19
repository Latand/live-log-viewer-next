import path from "node:path";

const result = await Bun.build({
  entrypoints: [path.join(process.cwd(), "src/lib/mcp/entry.ts")],
  outdir: path.join(process.cwd(), "dist"),
  naming: "mcp-server.mjs",
  target: "node",
  format: "esm",
  external: [
    "@modelcontextprotocol/sdk/*",
    "zod",
    "react",
    "react/*",
    "lucide-react",
    "highlight.js",
    "qrcode",
    "qrcode-terminal",
  ],
  plugins: [{
    name: "node-esm-next-entrypoints",
    setup(build) {
      build.onResolve({ filter: /^next(?:\/.*)?$/ }, (args) => ({
        path: args.path === "next/server" ? "next/server.js" : args.path,
        external: true,
      }));
    },
  }],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
} else {
  const output = result.outputs[0];
  const source = await Bun.file(output.path).text();
  const nodeEsmSource = source.replaceAll('"next/server"', '"next/server.js"');
  await Bun.write(output.path, nodeEsmSource);
  console.log(`Built ${path.relative(process.cwd(), output.path)} (${Buffer.byteLength(nodeEsmSource)} bytes)`);
}
