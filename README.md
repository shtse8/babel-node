## Installation

Just install it and add to your package:

With NPM:
```bash
  npm install --save-dev babel-enhanced-node
```

With Yarn:
```bash
  yarn add --dev babel-enhanced-node
```

(Make sure you have `babel-core` installed as dependency in your project as `babel-node` only defines `babel-core` as a "peerDependency")

Then use `babel-node` in your `package.json` in scripts section like this:
```json
  "scripts": {
    "start": "babel-node src/main.js"
  }
```

Or if you want to run directly:
```bash
  yarn babel-node src/main.js
```
