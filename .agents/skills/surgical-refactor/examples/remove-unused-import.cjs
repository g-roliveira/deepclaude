// Explicit module selector, conservative reference check, dry-run first.
module.exports = function transform(file, api, options) {
  if (!options.module) throw new Error('Pass --module=<exact-package-or-path>');
  const j = api.jscodeshift;
  const root = j(file.source);
  root.find(j.ImportDeclaration, { source: { value: options.module } }).forEach(path => {
    if (!path.node.specifiers.length) throw new Error('Side-effect import: review initialization behavior before removing.');
    for (const specifier of path.node.specifiers) {
      const name = specifier.local?.name;
      const outsideImport = root.find(j.Identifier, { name }).filter(ref => {
        let parent = ref;
        while (parent) {
          if (parent.node?.type === 'ImportDeclaration') return false;
          parent = parent.parentPath;
        }
        return true;
      });
      if (outsideImport.size()) throw new Error(`Shared or live binding ${name}; remove/replace callers first.`);
    }
    j(path).remove();
  });
  return root.toSource();
};
