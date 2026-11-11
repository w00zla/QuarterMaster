// Preloaded into a spawned singleuser process (NODE_OPTIONS=--import): any use of fetch is a test failure, not a request.
globalThis.fetch = () => {
  console.error('BLOCKED FETCH');
  return Promise.reject(new Error('fetch is blocked in this process'));
};
