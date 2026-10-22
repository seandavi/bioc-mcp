globalThis.fetch = () => {
  throw new Error('Network access is disabled in tests; inject a fixture fetch via deps.fetch');
};
