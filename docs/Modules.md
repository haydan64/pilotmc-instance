# Optional modules

A module is either a JavaScript file in `modules` or a directory containing `index.js`. It may export an initializer as its default export. The initializer receives the generic runtime context and may return metadata or hooks.

```js
module.exports = async function initialize(context) {
  return {
    name: 'example-module'
  };
};
```

No base file should import a particular module by name or path. Keep community rules, custom roles, gameplay systems, and other deployment-specific behavior in modules that are distributed separately.
