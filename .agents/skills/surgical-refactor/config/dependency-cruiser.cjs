module.exports = {
  forbidden: [
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
    { name: 'no-production-to-tests', severity: 'error', from: { path: '^proxy/', pathNot: '\\.test\\.js$' }, to: { path: '\\.test\\.js$' } },
    { name: 'no-unresolved-imports', severity: 'error', from: {}, to: { couldNotResolve: true } },
  ],
  options: { doNotFollow: { path: 'node_modules' }, exclude: { path: '(node_modules|\\.surgical-refactor/artifacts)' } },
};
