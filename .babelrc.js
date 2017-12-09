var env = process.env.BABEL_ENV || process.env.NODE_ENV
var target = process.env.BABEL_TARGET

let targets = {}
let options = {
  sourceMaps: true,
  presets: [
    ["@babel/env", {
      "targets": targets
    }],
    "@babel/stage-2"
  ],
  plugins: [
    "@babel/transform-runtime",
    "@babel/plugin-proposal-decorators",
    "babel-plugin-root-import"
  ]
}

if (target === 'browser') {
  targets.browsers = ["last 1 versions", "not ie > 0"]
  options.plugins.push("graphql-tag")
}

module.exports = options