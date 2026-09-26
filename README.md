<p align="center">
  <img src="https://mark.sylphx.com/api/v1/mark/hero.svg?type=waving&theme=dark&text=babel-node&desc=Babel%20for%20Node.js" alt="babel-node" width="100%" />
</p>

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
