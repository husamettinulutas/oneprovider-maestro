const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  logLevel: 'info',
  plugins: [],
};

/*
  Two bundles. dist/uninstall.js is the vscode:uninstall hook, which VS Code
  runs as a bare Node process after the extension is gone -- it must not carry
  a "vscode" import, so it gets its own entry point rather than being reachable
  from extension.ts.
*/
const targets = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  { ...common, entryPoints: ['src/uninstall.ts'], outfile: 'dist/uninstall.js' },
];

async function main() {
  const contexts = await Promise.all(targets.map((t) => esbuild.context(t)));

  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('Watching for changes...');
  } else {
    for (const ctx of contexts) {
      await ctx.rebuild();
      await ctx.dispose();
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
