// A real defect that is not a test failure: test code leaves a promise
// rejection unhandled. Vitest reports it as an unhandled error and fails the
// run without printing "N failed".
it('leaves a rejection unhandled', async () => {
  void Promise.reject(new Error('rejected and never handled'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(1).toBe(1);
});
