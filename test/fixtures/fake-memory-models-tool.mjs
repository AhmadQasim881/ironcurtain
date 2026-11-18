#!/usr/bin/env node
// Stands in for `memory-mcp-server --verify-models | --prefetch-models` in
// test/memory-models.test.ts. What it does depends on the last component of
// MEMORY_MODELS_DIR:
//   hang       never exits
//   no-report  writes to stderr and exits 3 without a report
//   missing    reports the embedding model missing and exits 1
//   anything   reports it verified and exits 0
// The report's detail records how it was started (argv, cwd, two variables
// it must not or must see), for the test to check.

const flag = process.argv[2];
const dir = process.env.MEMORY_MODELS_DIR ?? '';
const mode = dir.split('/').pop();

if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (mode === 'no-report') {
  process.stderr.write('Downloading ...\nfatal: something broke\n');
  process.exit(3);
} else {
  const action = flag === '--verify-models' ? 'verify' : flag === '--prefetch-models' ? 'prefetch' : flag;
  const probe = {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? null,
    httpsProxy: process.env.HTTPS_PROXY ?? null,
  };
  process.stderr.write('Downloading Xenova/bge-base-en-v1.5 config.json ...\n');
  process.stdout.write('a line that is not the report\n');
  const report = {
    action,
    modelsDir: dir,
    offline: false,
    models: [
      {
        role: 'embedding',
        repo: 'Xenova/bge-base-en-v1.5',
        dtype: 'q8',
        status: mode === 'missing' ? 'missing' : 'ok',
        detail: JSON.stringify(probe),
      },
    ],
  };
  process.stdout.write(`${JSON.stringify(report)}\n`, () => process.exit(mode === 'missing' ? 1 : 0));
}
