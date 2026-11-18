import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    // A verified model store for the suites that load the real models (see the
    // file); they pick it up through test/helpers/test-models.ts.
    globalSetup: ['test/setup/test-models.global.ts'],
    // Run test files serially. Several suites load the real ONNX embedding /
    // reranker models (a few hundred MB of memory each), and with a cold store
    // the first of them downloads the models for the rest. (Downloads are
    // installed atomically, so parallel files no longer see a half-written
    // model_quantized.onnx as they did in the release workflow.) This suite
    // runs in the release workflow, so the slowdown is fine.
    fileParallelism: false,
  },
});
