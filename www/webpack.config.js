const CopyWebpackPlugin = require("copy-webpack-plugin");
const path = require('path');

module.exports = {
  experiments: {
      asyncWebAssembly: true, // Enable async WebAssembly
    },
  entry: "./bootstrap.js",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "bootstrap.js",
  },
  mode: "development",
  plugins: [
    new CopyWebpackPlugin(['index.html'])
  ],
  module: {
    rules: [
      {
        test: /\.wasm$/,
        type: 'webassembly/async', // Use async WebAssembly loader
      },
    ],
  },
};
